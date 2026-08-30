/*
 * Tier B qualification for the complete CUDA precision policy.
 *
 * This is deliberately not a throughput-only smoke. It proves the executed
 * storage/compute/FFT/reduction realization, exercises exchange, DMI and
 * demag FFT, compares energy and trajectory, checks norm drift and hot-loop
 * workspace accounting, and measures time to an independent macrospin error.
 */

#include "fullmag_fdm.h"

#include <cuda_runtime.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <vector>

namespace {

void require(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void generate_unit_vectors(
    uint64_t seed,
    uint64_t cell_count,
    std::vector<double> &out)
{
    out.resize(cell_count * 3);
    uint64_t state = seed;
    for (uint64_t cell = 0; cell < cell_count; ++cell) {
        auto sample = [&state]() {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            return static_cast<double>(state % 10000) / 5000.0 - 1.0;
        };
        double x = sample();
        double y = sample();
        double z = sample();
        double norm = std::sqrt(x * x + y * y + z * z);
        if (norm < 1.0e-10) {
            x = 1.0;
            y = 0.0;
            z = 0.0;
            norm = 1.0;
        }
        out[3 * cell] = x / norm;
        out[3 * cell + 1] = y / norm;
        out[3 * cell + 2] = z / norm;
    }
}

void require_precision_policy(
    fullmag_fdm_backend *handle,
    fullmag_fdm_precision precision)
{
    fullmag_fdm_precision_policy_telemetry_v1 telemetry{};
    telemetry.abi_version = FULLMAG_FDM_PRECISION_POLICY_TELEMETRY_ABI_V1;
    telemetry.struct_size = sizeof(telemetry);
    require(fullmag_fdm_backend_get_precision_policy_telemetry_v1(
                handle, &telemetry) == FULLMAG_FDM_OK,
            "precision-policy telemetry query failed");
    const auto expected_realization =
        precision == FULLMAG_FDM_PRECISION_SINGLE
        ? FULLMAG_FDM_PRECISION_POLICY_SINGLE_STORAGE_FP64_REDUCTION
        : FULLMAG_FDM_PRECISION_POLICY_FULL_DOUBLE;
    require(telemetry.accounting_valid == 1 &&
                telemetry.metric_valid_mask ==
                    FULLMAG_FDM_PRECISION_POLICY_METRIC_IDENTITY &&
                telemetry.realization == expected_realization &&
                telemetry.storage_precision == precision &&
                telemetry.compute_precision == precision &&
                telemetry.fft_precision == precision &&
                telemetry.reduction_precision == FULLMAG_FDM_PRECISION_DOUBLE,
            "executed numeric components differ from the requested policy");
}

fullmag_fdm_endpoint_cache_telemetry_v1 endpoint_telemetry(
    fullmag_fdm_backend *handle)
{
    fullmag_fdm_endpoint_cache_telemetry_v1 telemetry{};
    telemetry.abi_version = FULLMAG_FDM_ENDPOINT_CACHE_TELEMETRY_ABI_V1;
    telemetry.struct_size = sizeof(telemetry);
    require(fullmag_fdm_backend_get_endpoint_cache_telemetry_v1(
                handle, &telemetry) == FULLMAG_FDM_OK,
            "endpoint-cache telemetry query failed");
    return telemetry;
}

fullmag_fdm_gpu_workspace_telemetry_v1 workspace_telemetry(
    fullmag_fdm_backend *handle)
{
    fullmag_fdm_gpu_workspace_telemetry_v1 telemetry{};
    telemetry.abi_version = FULLMAG_FDM_GPU_WORKSPACE_TELEMETRY_ABI_V1;
    telemetry.struct_size = sizeof(telemetry);
    require(fullmag_fdm_backend_get_gpu_workspace_telemetry_v1(
                handle, &telemetry) == FULLMAG_FDM_OK,
            "GPU workspace telemetry query failed");
    return telemetry;
}

fullmag_fdm_step_transaction_telemetry_v1 transaction_telemetry(
    fullmag_fdm_backend *handle)
{
    fullmag_fdm_step_transaction_telemetry_v1 telemetry{};
    telemetry.abi_version = FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1;
    telemetry.struct_size = sizeof(telemetry);
    require(fullmag_fdm_backend_get_step_transaction_telemetry_v1(
                handle, &telemetry) == FULLMAG_FDM_OK,
            "step-transaction telemetry query failed");
    return telemetry;
}

double max_component_difference(
    const std::vector<double> &reference,
    const std::vector<double> &candidate)
{
    require(reference.size() == candidate.size(), "comparison shape mismatch");
    double result = 0.0;
    for (size_t index = 0; index < reference.size(); ++index) {
        result = std::max(
            result, std::abs(reference[index] - candidate[index]));
    }
    return result;
}

double max_norm_defect(const std::vector<double> &magnetization) {
    require((magnetization.size() % 3) == 0,
            "magnetization vector is not AoS xyz");
    double result = 0.0;
    for (size_t index = 0; index < magnetization.size(); index += 3) {
        const double norm = std::sqrt(
            magnetization[index] * magnetization[index] +
            magnetization[index + 1] * magnetization[index + 1] +
            magnetization[index + 2] * magnetization[index + 2]);
        result = std::max(result, std::abs(norm - 1.0));
    }
    return result;
}

struct InteractionRun {
    std::vector<double> magnetization;
    std::vector<double> total_energy;
    std::vector<double> demag_energy;
    std::vector<double> dmi_energy;
    uint64_t wall_time_ns = 0;
    uint64_t demag_evaluations = 0;
    uint64_t forward_ffts = 0;
    uint64_t inverse_ffts = 0;
    uint64_t energy_reductions = 0;
    uint64_t peak_vram_bytes = 0;
    uint64_t accepted_steps = 0;
    uint64_t rollback_count = 0;
};

double max_absolute_value(const std::vector<double> &values) {
    double result = 0.0;
    for (const double value : values) {
        result = std::max(result, std::abs(value));
    }
    return result;
}

InteractionRun run_interaction_fixture(fullmag_fdm_precision precision) {
    constexpr uint32_t nx = 8;
    constexpr uint32_t ny = 8;
    constexpr uint32_t nz = 4;
    constexpr uint64_t cell_count =
        static_cast<uint64_t>(nx) * ny * nz;
    constexpr uint32_t step_count = 256;
    constexpr double dt = 1.0e-14;
    constexpr uint32_t fft_nx = 2 * nx;
    constexpr uint32_t fft_ny = 2 * ny;
    constexpr uint32_t fft_nz = 2 * nz;
    constexpr uint64_t fft_cell_count =
        static_cast<uint64_t>(fft_nx) * fft_ny * fft_nz;

    std::vector<double> initial_magnetization;
    generate_unit_vectors(12345, cell_count, initial_magnetization);

    // A deterministic, non-zero tensor spectrum isolates the precision of the
    // complete cuFFT/convolution path. Physical Newell correctness is covered
    // separately by the CPU/GPU demag oracle; this fixture compares policies.
    std::array<std::vector<double>, 6> kernel;
    for (auto &component : kernel) {
        component.assign(fft_cell_count * 2, 0.0);
    }
    for (uint64_t frequency = 0; frequency < fft_cell_count; ++frequency) {
        kernel[0][2 * frequency] = 0.31;
        kernel[1][2 * frequency] = 0.29;
        kernel[2][2 * frequency] = 0.40;
        kernel[3][2 * frequency] = 0.015;
        kernel[4][2 * frequency] = -0.010;
        kernel[5][2 * frequency] = 0.0075;
    }

    fullmag_fdm_plan_desc plan{};
    plan.grid = {nx, ny, nz, 2.0e-9, 2.0e-9, 2.0e-9};
    plan.material = {8.0e5, 13.0e-12, 0.5, 2.211e5};
    plan.precision = precision;
    plan.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
    plan.enable_exchange = 1;
    plan.enable_demag = 1;
    plan.has_external_field = 1;
    plan.external_field_am[2] = 1.0e4;
    plan.has_interfacial_dmi = 1;
    plan.dmi_D_interfacial = 2.5e-3;
    plan.has_bulk_dmi = 1;
    plan.dmi_D_bulk = -1.0e-3;
    plan.periodic_x = 1;
    plan.periodic_y = 1;
    plan.periodic_z = 1;
    plan.initial_magnetization_xyz = initial_magnetization.data();
    plan.initial_magnetization_len = initial_magnetization.size();
    plan.demag_kernel_xx_spectrum = kernel[0].data();
    plan.demag_kernel_yy_spectrum = kernel[1].data();
    plan.demag_kernel_zz_spectrum = kernel[2].data();
    plan.demag_kernel_xy_spectrum = kernel[3].data();
    plan.demag_kernel_xz_spectrum = kernel[4].data();
    plan.demag_kernel_yz_spectrum = kernel[5].data();
    plan.demag_kernel_spectrum_len = fft_cell_count * 2;
    plan.demag_fft_nx = fft_nx;
    plan.demag_fft_ny = fft_ny;
    plan.demag_fft_nz = fft_nz;
    plan.stats_mode = FULLMAG_FDM_STATS_FULL;
    plan.stats_stride = 1;

    auto *handle = fullmag_fdm_backend_create(&plan);
    require(handle != nullptr, "interaction fixture backend creation returned null");
    require(fullmag_fdm_backend_last_error(handle) == nullptr,
            "interaction fixture backend creation failed");
    require_precision_policy(handle, precision);
    const auto endpoint_before = endpoint_telemetry(handle);

    InteractionRun result;
    result.total_energy.reserve(step_count);
    result.demag_energy.reserve(step_count);
    result.dmi_energy.reserve(step_count);
    const auto start = std::chrono::steady_clock::now();
    for (uint32_t step = 0; step < step_count; ++step) {
        fullmag_fdm_step_stats stats{};
        require(fullmag_fdm_backend_step(handle, dt, &stats) == FULLMAG_FDM_OK,
                "interaction fixture step failed");
        require(std::isfinite(stats.total_energy_joules) &&
                    std::isfinite(stats.demag_energy_joules) &&
                    std::isfinite(stats.dmi_energy_joules),
                "interaction fixture produced a non-finite energy");
        result.total_energy.push_back(stats.total_energy_joules);
        result.demag_energy.push_back(stats.demag_energy_joules);
        result.dmi_energy.push_back(stats.dmi_energy_joules);
    }
    result.wall_time_ns = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now() - start).count());

    result.magnetization.resize(cell_count * 3);
    require(fullmag_fdm_backend_copy_field_f64(
                handle, FULLMAG_FDM_OBSERVABLE_M,
                result.magnetization.data(), result.magnetization.size()) ==
                FULLMAG_FDM_OK,
            "interaction fixture state readback failed");
    const auto endpoint_after = endpoint_telemetry(handle);
    const auto workspace = workspace_telemetry(handle);
    const auto transaction = transaction_telemetry(handle);
    result.demag_evaluations = endpoint_after.demag_evaluation_count -
        endpoint_before.demag_evaluation_count;
    result.forward_ffts = endpoint_after.demag_forward_fft_count -
        endpoint_before.demag_forward_fft_count;
    result.inverse_ffts = endpoint_after.demag_inverse_fft_count -
        endpoint_before.demag_inverse_fft_count;
    result.energy_reductions = endpoint_after.energy_reduction_count -
        endpoint_before.energy_reduction_count;
    result.peak_vram_bytes = workspace.peak_vram_bytes;
    result.accepted_steps = transaction.accepted_step_index;
    result.rollback_count = transaction.rollback_count;
    require(workspace.accounting_valid == 1 &&
                workspace.setup_complete == 1 &&
                workspace.step_device_allocation_count == 0 &&
                workspace.step_device_allocation_bytes == 0 &&
                workspace.step_fft_plan_creation_count == 0,
            "interaction fixture violated the steady-state workspace budget");
    require(result.accepted_steps == step_count && result.rollback_count == 0,
            "fixed-step interaction fixture transaction count is inconsistent");
    require(result.demag_evaluations > 0 &&
                result.demag_evaluations == result.forward_ffts &&
                result.demag_evaluations == result.inverse_ffts &&
                result.energy_reductions > 0,
            "demag FFT or FP64 reduction telemetry is incomplete");
    require(max_absolute_value(result.total_energy) > 0.0 &&
                max_absolute_value(result.demag_energy) > 0.0 &&
                max_absolute_value(result.dmi_energy) > 0.0,
            "interaction fixture did not materialize non-zero energies");
    fullmag_fdm_backend_destroy(handle);
    return result;
}

double max_relative_series_difference(
    const std::vector<double> &reference,
    const std::vector<double> &candidate)
{
    require(reference.size() == candidate.size(), "energy series shape mismatch");
    double result = 0.0;
    for (size_t index = 0; index < reference.size(); ++index) {
        const double scale = std::max(std::abs(reference[index]), 1.0e-30);
        result = std::max(
            result, std::abs(reference[index] - candidate[index]) / scale);
    }
    return result;
}

struct AccuracyResult {
    uint32_t steps = 0;
    uint64_t wall_time_ns = 0;
    double error = std::numeric_limits<double>::infinity();
};

void write_evidence(
    const InteractionRun &fp64,
    const InteractionRun &fp32,
    const AccuracyResult &fp64_accuracy,
    const AccuracyResult &fp32_accuracy,
    double trajectory_error,
    double total_energy_error,
    double demag_energy_error,
    double dmi_energy_error,
    double fp64_norm_defect,
    double fp32_norm_defect)
{
    const char *path = std::getenv(
        "FULLMAG_FDM_PRECISION_POLICY_EVIDENCE_PATH");
    if (!path || path[0] == '\0') return;
    const char *source_commit = std::getenv("FULLMAG_SOURCE_COMMIT");
    const char *source_diff = std::getenv("FULLMAG_SOURCE_DIFF_SHA256");
    require(source_commit && source_commit[0] != '\0' &&
                source_diff && source_diff[0] != '\0',
            "qualification evidence is missing source identity");
    int device_ordinal = 0;
    int driver_version = 0;
    int runtime_version = 0;
    cudaDeviceProp properties{};
    require(cudaGetDevice(&device_ordinal) == cudaSuccess &&
                cudaGetDeviceProperties(&properties, device_ordinal) ==
                    cudaSuccess &&
                cudaDriverGetVersion(&driver_version) == cudaSuccess &&
                cudaRuntimeGetVersion(&runtime_version) == cudaSuccess,
            "qualification evidence could not query CUDA identity");
    FILE *file = std::fopen(path, "wb");
    require(file != nullptr, "qualification evidence file could not be opened");
    std::fprintf(
        file,
        "{\n"
        "  \"schema\": \"fullmag.fdm.gpu.precision_qualification.v1\",\n"
        "  \"source_commit\": \"%s\",\n"
        "  \"source_diff_sha256\": \"%s\",\n"
        "  \"device\": {\"name\": \"%s\", \"ordinal\": %d, "
        "\"compute_capability\": \"%d.%d\", \"driver\": %d, "
        "\"runtime\": %d},\n"
        "  \"fixture\": {\"grid\": [8, 8, 4], \"integrator\": \"heun\", "
        "\"steps\": 256, \"active_interactions\": "
        "[\"exchange\", \"demag.tensor_fft_synthetic_precision_fixture\", "
        "\"uniform_zeeman\", \"interfacial_dmi\", \"bulk_dmi\"]},\n"
        "  \"policies\": {\n"
        "    \"fp64\": {\"requested\": \"full_double\", "
        "\"resolved\": \"fullmag.fdm.cuda.precision.full_double.v1\", "
        "\"executed\": \"fullmag.fdm.cuda.precision.full_double.v1\", "
        "\"accepted\": %llu, \"rejected\": 0, \"wall_time_ns\": %llu, "
        "\"peak_vram_bytes\": %llu},\n"
        "    \"fp32\": {\"requested\": \"single_storage_fp64_reduction\", "
        "\"resolved\": \"fullmag.fdm.cuda.precision.single_storage_fp64_reduction.v1\", "
        "\"executed\": \"fullmag.fdm.cuda.precision.single_storage_fp64_reduction.v1\", "
        "\"accepted\": %llu, \"rejected\": 0, \"wall_time_ns\": %llu, "
        "\"peak_vram_bytes\": %llu}\n"
        "  },\n"
        "  \"operator_counts\": {\"demag\": %llu, \"forward_fft\": %llu, "
        "\"inverse_fft\": %llu, \"fp64_reductions\": %llu},\n"
        "  \"errors\": {\"trajectory_max_component\": %.17g, "
        "\"total_energy_relative\": %.17g, \"demag_energy_relative\": %.17g, "
        "\"dmi_energy_relative\": %.17g, \"fp64_norm_defect\": %.17g, "
        "\"fp32_norm_defect\": %.17g},\n"
        "  \"time_to_accuracy\": {\"tolerance\": 0.0005, "
        "\"fp64\": {\"steps\": %u, \"wall_time_ns\": %llu, \"error\": %.17g}, "
        "\"fp32\": {\"steps\": %u, \"wall_time_ns\": %llu, \"error\": %.17g}},\n"
        "  \"budgets\": {\"trajectory\": 0.0002, \"energy\": 0.0002, "
        "\"fp64_norm_defect\": 1e-12, \"fp32_norm_defect\": 2e-6, "
        "\"fp32_wall_time_ratio_max\": 1.25},\n"
        "  \"stop_reason\": \"fixed_target_time_and_error_budget_reached\"\n"
        "}\n",
        source_commit, source_diff, properties.name, device_ordinal,
        properties.major, properties.minor, driver_version, runtime_version,
        static_cast<unsigned long long>(fp64.accepted_steps),
        static_cast<unsigned long long>(fp64.wall_time_ns),
        static_cast<unsigned long long>(fp64.peak_vram_bytes),
        static_cast<unsigned long long>(fp32.accepted_steps),
        static_cast<unsigned long long>(fp32.wall_time_ns),
        static_cast<unsigned long long>(fp32.peak_vram_bytes),
        static_cast<unsigned long long>(fp64.demag_evaluations),
        static_cast<unsigned long long>(fp64.forward_ffts),
        static_cast<unsigned long long>(fp64.inverse_ffts),
        static_cast<unsigned long long>(fp64.energy_reductions),
        trajectory_error, total_energy_error, demag_energy_error,
        dmi_energy_error, fp64_norm_defect, fp32_norm_defect,
        fp64_accuracy.steps,
        static_cast<unsigned long long>(fp64_accuracy.wall_time_ns),
        fp64_accuracy.error, fp32_accuracy.steps,
        static_cast<unsigned long long>(fp32_accuracy.wall_time_ns),
        fp32_accuracy.error);
    require(std::fclose(file) == 0,
            "qualification evidence file could not be finalized");
}

AccuracyResult qualify_macrospin_time_to_accuracy(
    fullmag_fdm_precision precision)
{
    constexpr double final_time = 1.0e-10;
    constexpr double alpha = 0.1;
    constexpr double gamma = 2.211e5;
    constexpr double field = 2.0e5;
    constexpr double tolerance = 5.0e-4;
    constexpr std::array<uint32_t, 6> sweep = {32, 64, 128, 256, 512, 1024};
    const double gamma_bar = gamma / (1.0 + alpha * alpha);
    const double phase = gamma_bar * field * final_time;
    const double damping_phase = alpha * phase;
    const double transverse = 1.0 / std::cosh(damping_phase);
    const std::vector<double> expected = {
        transverse * std::cos(phase),
        transverse * std::sin(phase),
        std::tanh(damping_phase),
    };
    static const double initial_m[3] = {1.0, 0.0, 0.0};
    static const uint8_t active_mask[1] = {1};

    for (const uint32_t steps : sweep) {
        fullmag_fdm_plan_desc plan{};
        plan.grid = {1, 1, 1, 5.0e-9, 5.0e-9, 5.0e-9};
        plan.material = {8.0e5, 1.0e-30, alpha, gamma};
        plan.precision = precision;
        plan.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
        plan.has_external_field = 1;
        plan.external_field_am[2] = field;
        plan.initial_magnetization_xyz = initial_m;
        plan.initial_magnetization_len = 3;
        plan.active_mask = active_mask;
        plan.active_mask_len = 1;
        plan.stats_mode = FULLMAG_FDM_STATS_NONE;

        auto *handle = fullmag_fdm_backend_create(&plan);
        require(handle != nullptr &&
                    fullmag_fdm_backend_last_error(handle) == nullptr,
                "macrospin accuracy backend creation failed");
        require_precision_policy(handle, precision);
        const double dt = final_time / static_cast<double>(steps);
        const auto start = std::chrono::steady_clock::now();
        for (uint32_t step = 0; step < steps; ++step) {
            fullmag_fdm_step_stats stats{};
            require(fullmag_fdm_backend_step(handle, dt, &stats) ==
                        FULLMAG_FDM_OK,
                    "macrospin accuracy step failed");
        }
        const uint64_t wall_time_ns = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::steady_clock::now() - start).count());
        std::vector<double> actual(3);
        require(fullmag_fdm_backend_copy_field_f64(
                    handle, FULLMAG_FDM_OBSERVABLE_M,
                    actual.data(), actual.size()) == FULLMAG_FDM_OK,
                "macrospin accuracy state readback failed");
        const double error = max_component_difference(expected, actual);
        fullmag_fdm_backend_destroy(handle);
        if (error <= tolerance) return {steps, wall_time_ns, error};
    }
    require(false, "precision policy did not reach the macrospin error budget");
    return {};
}

} // namespace

int main() {
    if (!fullmag_fdm_is_available()) {
        std::puts("SKIP: no CUDA device");
        return 0;
    }

    const auto fp64 = run_interaction_fixture(FULLMAG_FDM_PRECISION_DOUBLE);
    const auto fp32 = run_interaction_fixture(FULLMAG_FDM_PRECISION_SINGLE);
    const double trajectory_error =
        max_component_difference(fp64.magnetization, fp32.magnetization);
    const double total_energy_error =
        max_relative_series_difference(fp64.total_energy, fp32.total_energy);
    const double demag_energy_error =
        max_relative_series_difference(fp64.demag_energy, fp32.demag_energy);
    const double dmi_energy_error =
        max_relative_series_difference(fp64.dmi_energy, fp32.dmi_energy);
    const double fp64_norm_defect = max_norm_defect(fp64.magnetization);
    const double fp32_norm_defect = max_norm_defect(fp32.magnetization);

    require(trajectory_error <= 2.0e-4,
            "long-run FP32/FP64 trajectory error exceeded its budget");
    require(total_energy_error <= 2.0e-4 &&
                demag_energy_error <= 2.0e-4 &&
                dmi_energy_error <= 2.0e-4,
            "FP32/FP64 energy trajectory error exceeded its budget");
    require(fp64_norm_defect <= 1.0e-12 && fp32_norm_defect <= 2.0e-6,
            "long-run magnetization norm drift exceeded its budget");
    require(fp64.demag_evaluations == fp32.demag_evaluations &&
                fp64.forward_ffts == fp32.forward_ffts &&
                fp64.inverse_ffts == fp32.inverse_ffts &&
                fp64.energy_reductions == fp32.energy_reductions,
            "precision policies executed different operator schedules");
    require(fp32.peak_vram_bytes < fp64.peak_vram_bytes,
            "FP32 policy did not reduce peak VRAM");
    require(fp32.wall_time_ns * 4 <= fp64.wall_time_ns * 5,
            "FP32 interaction fixture regressed wall time by more than 25 percent");

    const auto fp64_accuracy =
        qualify_macrospin_time_to_accuracy(FULLMAG_FDM_PRECISION_DOUBLE);
    const auto fp32_accuracy =
        qualify_macrospin_time_to_accuracy(FULLMAG_FDM_PRECISION_SINGLE);

    write_evidence(
        fp64, fp32, fp64_accuracy, fp32_accuracy, trajectory_error,
        total_energy_error, demag_energy_error, dmi_energy_error,
        fp64_norm_defect, fp32_norm_defect);

    std::printf(
        "TRACE interaction trajectory=%.6e energy=(%.6e,%.6e,%.6e) "
        "norm=(%.6e,%.6e) wall_ns=(%llu,%llu) vram=(%llu,%llu) "
        "fft=%llu reductions=%llu rejected_ratio=0\n",
        trajectory_error, total_energy_error, demag_energy_error,
        dmi_energy_error, fp64_norm_defect, fp32_norm_defect,
        static_cast<unsigned long long>(fp64.wall_time_ns),
        static_cast<unsigned long long>(fp32.wall_time_ns),
        static_cast<unsigned long long>(fp64.peak_vram_bytes),
        static_cast<unsigned long long>(fp32.peak_vram_bytes),
        static_cast<unsigned long long>(fp64.forward_ffts),
        static_cast<unsigned long long>(fp64.energy_reductions));
    std::printf(
        "TRACE time-to-accuracy tolerance=5e-4 fp64=(steps=%u,ns=%llu,error=%.6e) "
        "fp32=(steps=%u,ns=%llu,error=%.6e)\n",
        fp64_accuracy.steps,
        static_cast<unsigned long long>(fp64_accuracy.wall_time_ns),
        fp64_accuracy.error,
        fp32_accuracy.steps,
        static_cast<unsigned long long>(fp32_accuracy.wall_time_ns),
        fp32_accuracy.error);
    std::puts("FDM_GPU_NUM002_PRECISION_POLICY_QUALIFICATION_PASS");
    return 0;
}

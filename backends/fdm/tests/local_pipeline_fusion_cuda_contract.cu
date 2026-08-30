#include "fullmag_fdm.h"
#include "context.hpp"

#include <cuda_runtime.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <type_traits>
#include <vector>

namespace {

using fullmag::fdm::Context;
using fullmag::fdm::DeviceVectorField;

enum class PhysicsCase {
    Base,
    Dmi,
    DemagDmi,
    DynamicOersted,
    PrescribedSot,
};

void require(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void require_precision_policy(
    fullmag_fdm_backend *handle,
    fullmag_fdm_precision requested_precision)
{
    fullmag_fdm_precision_policy_telemetry_v1 telemetry{};
    telemetry.abi_version = FULLMAG_FDM_PRECISION_POLICY_TELEMETRY_ABI_V1;
    telemetry.struct_size = sizeof(telemetry);
    require(fullmag_fdm_backend_get_precision_policy_telemetry_v1(
                handle, &telemetry) == FULLMAG_FDM_OK,
            "precision-policy telemetry query failed");
    require(telemetry.accounting_valid == 1,
            "precision-policy accounting is invalid");
    require(telemetry.metric_valid_mask ==
                FULLMAG_FDM_PRECISION_POLICY_METRIC_IDENTITY,
            "precision-policy metric identity is incomplete or unknown");
    require(telemetry.storage_precision == requested_precision &&
                telemetry.compute_precision == requested_precision &&
                telemetry.fft_precision == requested_precision,
            "storage/compute/FFT precision differs from the requested policy");
    require(telemetry.reduction_precision == FULLMAG_FDM_PRECISION_DOUBLE,
            "qualified CUDA reductions must execute in FP64");
    const auto expected_realization =
        requested_precision == FULLMAG_FDM_PRECISION_SINGLE
        ? FULLMAG_FDM_PRECISION_POLICY_SINGLE_STORAGE_FP64_REDUCTION
        : FULLMAG_FDM_PRECISION_POLICY_FULL_DOUBLE;
    require(telemetry.realization == expected_realization,
            "precision-policy realization differs from executed components");
}

void require_precision_policy_abi_rejects_invalid_header(
    fullmag_fdm_backend *handle)
{
    fullmag_fdm_precision_policy_telemetry_v1 telemetry{};
    telemetry.abi_version = UINT32_MAX;
    telemetry.struct_size = sizeof(telemetry);
    telemetry.metric_valid_mask = UINT64_MAX;
    const auto before = telemetry;
    require(fullmag_fdm_backend_get_precision_policy_telemetry_v1(
                handle, &telemetry) == FULLMAG_FDM_ERR_ABI,
            "precision-policy ABI accepted an unknown version");
    require(std::memcmp(&telemetry, &before, sizeof(telemetry)) == 0,
            "precision-policy ABI mutated output after header rejection");
}

const char *integrator_name(fullmag_fdm_integrator integrator) {
    switch (integrator) {
    case FULLMAG_FDM_INTEGRATOR_HEUN: return "heun";
    case FULLMAG_FDM_INTEGRATOR_RK4: return "rk4";
    case FULLMAG_FDM_INTEGRATOR_RK23: return "rk23";
    case FULLMAG_FDM_INTEGRATOR_DP45: return "dp45";
    case FULLMAG_FDM_INTEGRATOR_ABM3: return "abm3";
    default: return "unknown";
    }
}

const char *physics_case_name(PhysicsCase physics_case) {
    switch (physics_case) {
    case PhysicsCase::Base: return "base";
    case PhysicsCase::Dmi: return "dmi";
    case PhysicsCase::DemagDmi: return "demag-dmi";
    case PhysicsCase::DynamicOersted: return "dynamic-oersted";
    case PhysicsCase::PrescribedSot: return "prescribed-sot";
    default: return "unknown";
    }
}

uint64_t expected_rhs_stage_count(fullmag_fdm_integrator integrator) {
    switch (integrator) {
    case FULLMAG_FDM_INTEGRATOR_HEUN: return 2;
    case FULLMAG_FDM_INTEGRATOR_RK4: return 4;
    case FULLMAG_FDM_INTEGRATOR_RK23: return 4;
    case FULLMAG_FDM_INTEGRATOR_DP45: return 7;
    // Three Heun startup steps use 3 RHS evaluations each. The first steady
    // ABM3 step uses predictor and accepted-endpoint evaluations.
    case FULLMAG_FDM_INTEGRATOR_ABM3: return 11;
    default: return 0;
    }
}

template <typename Scalar>
std::vector<double> copy_device_vector(
    const DeviceVectorField &field,
    uint64_t cell_count)
{
    std::array<std::vector<Scalar>, 3> soa;
    for (auto &component : soa) component.resize(cell_count);
    const size_t bytes = static_cast<size_t>(cell_count) * sizeof(Scalar);
    require(cudaMemcpy(soa[0].data(), field.x, bytes, cudaMemcpyDeviceToHost) ==
                cudaSuccess,
            "device x-component readback failed");
    require(cudaMemcpy(soa[1].data(), field.y, bytes, cudaMemcpyDeviceToHost) ==
                cudaSuccess,
            "device y-component readback failed");
    require(cudaMemcpy(soa[2].data(), field.z, bytes, cudaMemcpyDeviceToHost) ==
                cudaSuccess,
            "device z-component readback failed");
    std::vector<double> aos(cell_count * 3, 0.0);
    for (uint64_t cell = 0; cell < cell_count; ++cell) {
        aos[3 * cell] = static_cast<double>(soa[0][cell]);
        aos[3 * cell + 1] = static_cast<double>(soa[1][cell]);
        aos[3 * cell + 2] = static_cast<double>(soa[2][cell]);
    }
    return aos;
}

double max_difference(
    const std::vector<double> &left,
    const std::vector<double> &right)
{
    require(left.size() == right.size(), "comparison shape mismatch");
    double result = 0.0;
    for (size_t index = 0; index < left.size(); ++index) {
        result = std::max(result, std::abs(left[index] - right[index]));
    }
    return result;
}

double max_scaled_difference(
    const std::vector<double> &reference,
    const std::vector<double> &candidate)
{
    require(reference.size() == candidate.size(), "comparison shape mismatch");
    double result = 0.0;
    for (size_t index = 0; index < reference.size(); ++index) {
        const double scale = std::max(
            {1.0, std::abs(reference[index]), std::abs(candidate[index])});
        result = std::max(
            result, std::abs(reference[index] - candidate[index]) / scale);
    }
    return result;
}

struct RunResult {
    std::vector<double> field;
    std::vector<double> rhs;
    std::vector<double> magnetization;
    uint64_t fused_launches = 0;
    uint64_t unfused_field_launches = 0;
    uint64_t unfused_rhs_launches = 0;
    uint64_t captured_fused_nodes = 0;
    uint64_t captured_unfused_field_nodes = 0;
    uint64_t captured_unfused_rhs_nodes = 0;
    uint64_t graph_builds = 0;
    uint64_t graph_launches = 0;
    uint64_t graph_recaptures = 0;
    uint64_t graph_attempts = 0;
    uint64_t graph_fused_executions = 0;
    uint64_t graph_unfused_field_executions = 0;
    uint64_t graph_unfused_rhs_executions = 0;
    uint64_t metric_valid_mask = 0;
    uint64_t required_operator_mask = 0;
    uint64_t active_feature_mask = 0;
    uint64_t source_revision = 0;
    uint64_t field_revision = 0;
    fullmag_fdm_local_pipeline_policy_v1 requested_policy =
        FULLMAG_FDM_LOCAL_PIPELINE_POLICY_AUTO_SAFE;
    fullmag_fdm_local_pipeline_realization_v1 resolved_realization =
        FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_NONE;
    fullmag_fdm_local_pipeline_realization_v1 executed_realization =
        FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_NONE;
    uint32_t accounting_valid = 0;
    uint32_t workspace_accounting_valid = 0;
    uint32_t workspace_setup_complete = 0;
    uint64_t workspace_metric_valid_mask = 0;
    uint64_t setup_device_allocation_count = 0;
    uint64_t setup_device_allocation_bytes = 0;
    uint64_t total_device_allocation_count = 0;
    uint64_t total_device_allocation_bytes = 0;
    uint64_t step_device_allocation_count = 0;
    uint64_t step_device_allocation_bytes = 0;
    uint64_t setup_fft_plan_creation_count = 0;
    uint64_t total_fft_plan_creation_count = 0;
    uint64_t step_fft_plan_creation_count = 0;
    uint64_t workspace_bytes = 0;
    uint64_t peak_vram_bytes = 0;
    uint64_t observed_step_count = 0;
    uint64_t demag_evaluations = 0;
    uint64_t demag_forward_ffts = 0;
    uint64_t demag_inverse_ffts = 0;
};

RunResult run_once(
    fullmag_fdm_integrator integrator,
    fullmag_fdm_precision precision,
    bool force_unfused,
    bool use_adaptive_graph,
    uint32_t step_count,
    PhysicsCase physics_case = PhysicsCase::Base,
    fullmag_fdm_stats_mode stats_mode = FULLMAG_FDM_STATS_NONE)
{
    constexpr uint32_t nx = 4;
    constexpr uint32_t ny = 1;
    constexpr uint32_t nz = 1;
    constexpr uint64_t cell_count = nx * ny * nz;
    constexpr double dt = 2.5e-14;

    std::vector<double> magnetization = {
        0.8, 0.6, 0.0,
        0.0, 1.0, 0.0,
        0.6, 0.0, 0.8,
        1.0, 0.0, 0.0,
    };
    const std::array<uint8_t, cell_count> active_mask = {1, 1, 1, 0};
    const std::array<uint8_t, cell_count> frozen_mask = {0, 1, 0, 0};
    std::vector<double> static_profile = {
        2.0e3, -1.0e3, 0.5e3,
        1.0e3, 0.5e3, -0.25e3,
        -0.5e3, 1.5e3, 0.75e3,
        9.0e3, 9.0e3, 9.0e3,
    };
    constexpr uint32_t fft_nx = 2 * nx;
    constexpr uint32_t fft_ny = 2;
    constexpr uint32_t fft_nz = 2;
    constexpr uint64_t fft_cell_count =
        static_cast<uint64_t>(fft_nx) * fft_ny * fft_nz;
    std::array<std::vector<double>, 6> demag_kernel;
    for (auto &component : demag_kernel) {
        component.assign(fft_cell_count * 2, 0.0);
    }
    for (uint64_t frequency = 0; frequency < fft_cell_count; ++frequency) {
        demag_kernel[0][2 * frequency] = 0.31;
        demag_kernel[1][2 * frequency] = 0.29;
        demag_kernel[2][2 * frequency] = 0.40;
        demag_kernel[3][2 * frequency] = 0.015;
        demag_kernel[4][2 * frequency] = -0.010;
        demag_kernel[5][2 * frequency] = 0.0075;
    }

    fullmag_fdm_plan_desc plan{};
    plan.grid = {nx, ny, nz, 2e-9, 2e-9, 2e-9};
    plan.material = {8.0e5, 1.0e-30, 0.12, 2.211e5};
    plan.precision = precision;
    plan.integrator = integrator;
    if (physics_case != PhysicsCase::DynamicOersted) {
        plan.has_external_field = 1;
        plan.external_field_am[0] = 1.25e4;
        plan.external_field_am[2] = -0.5e4;
        plan.has_uniaxial_anisotropy = 1;
        plan.uniaxial_anisotropy_constant = 4.0e5;
        plan.uniaxial_anisotropy_k2 = 2.0e4;
        plan.anisotropy_axis[2] = 1.0;
        plan.has_magnetoelastic = 1;
        plan.mel_b1 = -3.4e6;
        plan.mel_b2 = 7.8e6;
        plan.mel_strain[0] = 1.0e-4;
        plan.mel_strain[1] = -0.5e-4;
        plan.mel_strain[5] = 0.25e-4;
    }
    if (physics_case == PhysicsCase::DynamicOersted) {
        plan.has_oersted_cylinder = 1;
        plan.oersted_current = 2.0;
        plan.oersted_radius = 0.5e-9;
        plan.oersted_center[1] = 1.0e-9;
        plan.oersted_center[2] = 1.0e-9;
        plan.oersted_axis[2] = 1.0;
        plan.oersted_time_dep_kind = 1;
        plan.oersted_time_dep_freq = 5.0e12;
        plan.oersted_time_dep_phase = 0.2;
        plan.oersted_time_dep_offset = 1.25;
    }
    if (physics_case == PhysicsCase::PrescribedSot) {
        plan.has_sot = 1;
        plan.sot_formula = FULLMAG_FDM_PRESCRIBED_SOT_V1;
        plan.sot_je = 1.0e12;
        plan.sot_xi_dl = 0.2;
        plan.sot_xi_fl = -0.1;
        plan.sot_sigma[2] = 1.0;
        plan.sot_thickness = 1.0e-9;
        plan.sot_active_mask = active_mask.data();
        plan.sot_active_mask_len = active_mask.size();
    }
    if (physics_case == PhysicsCase::Dmi ||
        physics_case == PhysicsCase::DemagDmi) {
        plan.has_interfacial_dmi = 1;
        plan.dmi_D_interfacial = 2.5e-3;
        plan.has_bulk_dmi = 1;
        plan.dmi_D_bulk = -1.25e-3;
    }
    if (physics_case == PhysicsCase::DemagDmi) {
        plan.enable_demag = 1;
        plan.demag_kernel_xx_spectrum = demag_kernel[0].data();
        plan.demag_kernel_yy_spectrum = demag_kernel[1].data();
        plan.demag_kernel_zz_spectrum = demag_kernel[2].data();
        plan.demag_kernel_xy_spectrum = demag_kernel[3].data();
        plan.demag_kernel_xz_spectrum = demag_kernel[4].data();
        plan.demag_kernel_yz_spectrum = demag_kernel[5].data();
        plan.demag_kernel_spectrum_len = fft_cell_count * 2;
        plan.demag_fft_nx = fft_nx;
        plan.demag_fft_ny = fft_ny;
        plan.demag_fft_nz = fft_nz;
    }
    plan.initial_magnetization_xyz = magnetization.data();
    plan.initial_magnetization_len = magnetization.size();
    plan.active_mask = active_mask.data();
    plan.active_mask_len = active_mask.size();
    plan.frozen_mask = frozen_mask.data();
    plan.frozen_mask_len = frozen_mask.size();
    plan.frozen_reference_xyz = magnetization.data();
    plan.frozen_reference_len = magnetization.size();
    if (use_adaptive_graph) {
        plan.adaptive_max_error = 1.0;
        plan.adaptive_dt_min = dt;
        plan.adaptive_dt_max = dt;
        plan.adaptive_headroom = 0.8;
    }
    plan.stats_mode = stats_mode;
    plan.stats_stride = 1;

    auto *handle = fullmag_fdm_backend_create(&plan);
    require(handle != nullptr, "local-pipeline backend creation returned null");
    require(fullmag_fdm_backend_last_error(handle) == nullptr,
            "local-pipeline backend creation failed");
    if (physics_case != PhysicsCase::DynamicOersted) {
        require(fullmag_fdm_backend_set_static_external_field_f64(
                    handle, static_profile.data(), static_profile.size()) ==
                    FULLMAG_FDM_OK,
                "static external profile upload failed");
    }

    auto *context = reinterpret_cast<Context *>(handle);
    // The legacy v1 constructor enables adaptive semantics for embedded RK
    // integrators unconditionally. This internal contract selects the fixed
    // realization explicitly; the graph realization is qualified separately.
    if (!use_adaptive_graph) context->adaptive_enabled = false;
    context->local_pipeline_force_unfused_for_testing = force_unfused;
    fullmag_fdm_step_stats stats{};
    for (uint32_t step = 0; step < step_count; ++step) {
        require(fullmag_fdm_backend_step(handle, dt, &stats) == FULLMAG_FDM_OK,
                "local-pipeline step failed");
    }

    RunResult result;
    if (precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        result.field = copy_device_vector<double>(context->work, cell_count);
        result.rhs = copy_device_vector<double>(context->k1, cell_count);
    } else {
        result.field = copy_device_vector<float>(context->work, cell_count);
        result.rhs = copy_device_vector<float>(context->k1, cell_count);
    }
    result.magnetization.resize(cell_count * 3, 0.0);
    require(fullmag_fdm_backend_copy_field_f64(
                handle, FULLMAG_FDM_OBSERVABLE_M,
                result.magnetization.data(), result.magnetization.size()) ==
                FULLMAG_FDM_OK,
            "local-pipeline trajectory readback failed");
    fullmag_fdm_local_pipeline_telemetry_v1 telemetry{};
    telemetry.abi_version = FULLMAG_FDM_LOCAL_PIPELINE_TELEMETRY_ABI_V1;
    telemetry.struct_size = sizeof(telemetry);
    require(fullmag_fdm_backend_get_local_pipeline_telemetry_v1(
                handle, &telemetry) == FULLMAG_FDM_OK,
            "local-pipeline telemetry query failed");
    require_precision_policy(handle, precision);
    require_precision_policy_abi_rejects_invalid_header(handle);
    result.fused_launches = telemetry.direct_fused_field_rhs_launch_count;
    result.unfused_field_launches =
        telemetry.direct_unfused_effective_field_launch_count;
    result.unfused_rhs_launches = telemetry.direct_unfused_rhs_launch_count;
    result.captured_fused_nodes =
        telemetry.captured_fused_field_rhs_node_count;
    result.captured_unfused_field_nodes =
        telemetry.captured_unfused_effective_field_node_count;
    result.captured_unfused_rhs_nodes =
        telemetry.captured_unfused_rhs_node_count;
    result.graph_builds = telemetry.graph_build_count;
    result.graph_launches = telemetry.graph_replay_count;
    result.graph_recaptures = telemetry.graph_recapture_count;
    result.graph_attempts = telemetry.graph_attempt_execution_count;
    result.graph_fused_executions =
        telemetry.graph_fused_field_rhs_execution_count;
    result.graph_unfused_field_executions =
        telemetry.graph_unfused_effective_field_execution_count;
    result.graph_unfused_rhs_executions =
        telemetry.graph_unfused_rhs_execution_count;
    result.metric_valid_mask = telemetry.metric_valid_mask;
    result.required_operator_mask = telemetry.required_operator_mask;
    result.active_feature_mask = telemetry.active_feature_mask;
    result.source_revision = telemetry.source_revision;
    result.field_revision = telemetry.field_revision;
    result.requested_policy = telemetry.requested_policy;
    result.resolved_realization = telemetry.resolved_realization;
    result.executed_realization = telemetry.executed_realization;
    result.accounting_valid = telemetry.accounting_valid;
    require(telemetry.profiled_dram_read_bytes == 0 &&
                telemetry.profiled_dram_write_bytes == 0 &&
                telemetry.profiled_launch_time_ns == 0 &&
                telemetry.profiled_achieved_occupancy_permyriad == 0,
            "unmeasured profiler metrics must remain zero");

    fullmag_fdm_gpu_workspace_telemetry_v1 workspace{};
    workspace.abi_version = FULLMAG_FDM_GPU_WORKSPACE_TELEMETRY_ABI_V1;
    workspace.struct_size = sizeof(workspace);
    require(fullmag_fdm_backend_get_gpu_workspace_telemetry_v1(
                handle, &workspace) == FULLMAG_FDM_OK,
            "GPU workspace telemetry query failed");
    require(workspace.precision == precision &&
                workspace.integrator == integrator,
            "GPU workspace identity differs from the executed plan");
    result.workspace_accounting_valid = workspace.accounting_valid;
    result.workspace_setup_complete = workspace.setup_complete;
    result.workspace_metric_valid_mask = workspace.metric_valid_mask;
    result.setup_device_allocation_count =
        workspace.setup_device_allocation_count;
    result.setup_device_allocation_bytes =
        workspace.setup_device_allocation_bytes;
    result.total_device_allocation_count =
        workspace.total_device_allocation_count;
    result.total_device_allocation_bytes =
        workspace.total_device_allocation_bytes;
    result.step_device_allocation_count =
        workspace.step_device_allocation_count;
    result.step_device_allocation_bytes = workspace.step_device_allocation_bytes;
    result.setup_fft_plan_creation_count =
        workspace.setup_fft_plan_creation_count;
    result.total_fft_plan_creation_count =
        workspace.total_fft_plan_creation_count;
    result.step_fft_plan_creation_count =
        workspace.step_fft_plan_creation_count;
    result.workspace_bytes = workspace.workspace_bytes;
    result.peak_vram_bytes = workspace.peak_vram_bytes;
    result.observed_step_count = workspace.observed_step_count;
    fullmag_fdm_endpoint_cache_telemetry_v1 endpoint{};
    endpoint.abi_version = FULLMAG_FDM_ENDPOINT_CACHE_TELEMETRY_ABI_V1;
    endpoint.struct_size = sizeof(endpoint);
    require(fullmag_fdm_backend_get_endpoint_cache_telemetry_v1(
                handle, &endpoint) == FULLMAG_FDM_OK,
            "endpoint-cache telemetry query failed");
    result.demag_evaluations = endpoint.demag_evaluation_count;
    result.demag_forward_ffts = endpoint.demag_forward_fft_count;
    result.demag_inverse_ffts = endpoint.demag_inverse_fft_count;
    fullmag_fdm_backend_destroy(handle);
    return result;
}

void qualify_case(
    fullmag_fdm_integrator integrator,
    fullmag_fdm_precision precision,
    PhysicsCase physics_case = PhysicsCase::Base,
    fullmag_fdm_stats_mode stats_mode = FULLMAG_FDM_STATS_NONE)
{
    const uint32_t step_count =
        integrator == FULLMAG_FDM_INTEGRATOR_ABM3 ? 4U : 1U;
    const auto fused = run_once(
        integrator, precision, false, false, step_count, physics_case,
        stats_mode);
    const auto unfused = run_once(
        integrator, precision, true, false, step_count, physics_case,
        stats_mode);
    const uint64_t stages = expected_rhs_stage_count(integrator);
    std::printf(
        "TRACE %s %s %s fused=(%llu,%llu,%llu) unfused=(%llu,%llu,%llu)\n",
        physics_case_name(physics_case),
        integrator_name(integrator),
        precision == FULLMAG_FDM_PRECISION_DOUBLE ? "fp64" : "fp32",
        static_cast<unsigned long long>(fused.fused_launches),
        static_cast<unsigned long long>(fused.unfused_field_launches),
        static_cast<unsigned long long>(fused.unfused_rhs_launches),
        static_cast<unsigned long long>(unfused.fused_launches),
        static_cast<unsigned long long>(unfused.unfused_field_launches),
        static_cast<unsigned long long>(unfused.unfused_rhs_launches));
    require(stages != 0, "missing expected stage count");
    require(fused.accounting_valid == 1 && unfused.accounting_valid == 1,
            "local-pipeline accounting is invalid");
    const uint64_t required_workspace_metrics =
        FULLMAG_FDM_GPU_WORKSPACE_METRIC_IDENTITY |
        FULLMAG_FDM_GPU_WORKSPACE_METRIC_ALLOCATIONS |
        FULLMAG_FDM_GPU_WORKSPACE_METRIC_FFT_PLANS |
        FULLMAG_FDM_GPU_WORKSPACE_METRIC_FOOTPRINT |
        FULLMAG_FDM_GPU_WORKSPACE_METRIC_REVISIONS;
    require(fused.workspace_accounting_valid == 1 &&
                fused.workspace_setup_complete == 1 &&
                (fused.workspace_metric_valid_mask &
                    required_workspace_metrics) == required_workspace_metrics,
            "GPU workspace accounting is incomplete");
    std::printf(
        "TRACE workspace %s %s setup=(%llu,%llu) total=(%llu,%llu) "
        "step=(%llu,%llu) fft=(%llu,%llu,%llu) live=%llu peak=%llu\n",
        integrator_name(integrator),
        precision == FULLMAG_FDM_PRECISION_DOUBLE ? "fp64" : "fp32",
        static_cast<unsigned long long>(fused.setup_device_allocation_count),
        static_cast<unsigned long long>(fused.setup_device_allocation_bytes),
        static_cast<unsigned long long>(fused.total_device_allocation_count),
        static_cast<unsigned long long>(fused.total_device_allocation_bytes),
        static_cast<unsigned long long>(fused.step_device_allocation_count),
        static_cast<unsigned long long>(fused.step_device_allocation_bytes),
        static_cast<unsigned long long>(fused.setup_fft_plan_creation_count),
        static_cast<unsigned long long>(fused.total_fft_plan_creation_count),
        static_cast<unsigned long long>(fused.step_fft_plan_creation_count),
        static_cast<unsigned long long>(fused.workspace_bytes),
        static_cast<unsigned long long>(fused.peak_vram_bytes));
    require(fused.setup_device_allocation_count > 0 &&
                fused.setup_device_allocation_bytes > 0 &&
                fused.total_device_allocation_count >=
                    fused.setup_device_allocation_count &&
                fused.total_device_allocation_bytes >=
                    fused.setup_device_allocation_bytes &&
                fused.step_device_allocation_count == 0 &&
                fused.step_device_allocation_bytes == 0,
            "steady-state step performed an unplanned device allocation");
    require(fused.total_fft_plan_creation_count ==
                fused.setup_fft_plan_creation_count &&
                fused.step_fft_plan_creation_count == 0,
            "steady-state step created an FFT plan");
    require(fused.workspace_bytes > 0 &&
                fused.peak_vram_bytes >= fused.workspace_bytes &&
                fused.observed_step_count == step_count,
            "workspace footprint or observed-step telemetry is inconsistent");
    require(fused.requested_policy ==
                FULLMAG_FDM_LOCAL_PIPELINE_POLICY_AUTO_SAFE &&
                unfused.requested_policy ==
                FULLMAG_FDM_LOCAL_PIPELINE_POLICY_AUTO_SAFE,
            "local-pipeline requested policy is not preserved");
    require(fused.resolved_realization ==
                FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_DIRECT_FUSED &&
                fused.executed_realization ==
                FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_DIRECT_FUSED &&
                unfused.resolved_realization ==
                FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_DIRECT_UNFUSED &&
                unfused.executed_realization ==
                FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_DIRECT_UNFUSED,
            "fixed-step requested/resolved/executed realization mismatch");
    require(fused.fused_launches == stages,
            "production path did not fuse every local field/RHS stage");
    require(fused.unfused_field_launches == 0 &&
                fused.unfused_rhs_launches == 0,
            "production fused path launch accounting is inconsistent");
    require(unfused.fused_launches == 0,
            "forced unfused oracle executed a fused launch");
    require(unfused.unfused_field_launches == stages &&
                unfused.unfused_rhs_launches == stages,
            "unfused oracle launch accounting does not match tableau stages");
    require(fused.captured_fused_nodes == 0 &&
                unfused.captured_unfused_field_nodes == 0 &&
                unfused.captured_unfused_rhs_nodes == 0 &&
                fused.graph_builds == 0 && fused.graph_launches == 0 &&
                unfused.graph_builds == 0 && unfused.graph_launches == 0,
            "fixed-step contract unexpectedly used CUDA Graph accounting");
    const uint64_t required_metric_mask =
        FULLMAG_FDM_LOCAL_PIPELINE_METRIC_IDENTITY |
        FULLMAG_FDM_LOCAL_PIPELINE_METRIC_DIRECT_SUBMISSIONS |
        FULLMAG_FDM_LOCAL_PIPELINE_METRIC_CAPTURED_NODES |
        FULLMAG_FDM_LOCAL_PIPELINE_METRIC_GRAPH_LIFECYCLE |
        FULLMAG_FDM_LOCAL_PIPELINE_METRIC_GRAPH_EXECUTIONS;
    const uint64_t forbidden_profile_mask =
        FULLMAG_FDM_LOCAL_PIPELINE_METRIC_PROFILED_DRAM_BYTES |
        FULLMAG_FDM_LOCAL_PIPELINE_METRIC_PROFILED_LAUNCH_TIME |
        FULLMAG_FDM_LOCAL_PIPELINE_METRIC_PROFILED_OCCUPANCY;
    require((fused.metric_valid_mask & required_metric_mask) ==
                required_metric_mask &&
                (fused.metric_valid_mask & forbidden_profile_mask) == 0 &&
                fused.required_operator_mask != 0 &&
                fused.active_feature_mask != 0,
            "local-pipeline metric validity or identity mask is inconsistent");
    if (physics_case == PhysicsCase::DynamicOersted) {
        require((fused.active_feature_mask &
                    FULLMAG_FDM_LOCAL_PIPELINE_FEATURE_OERSTED) != 0 &&
                    (unfused.active_feature_mask &
                        FULLMAG_FDM_LOCAL_PIPELINE_FEATURE_OERSTED) != 0,
                "dynamic Oersted feature is absent from pipeline identity");
    }
    if (physics_case == PhysicsCase::Dmi ||
        physics_case == PhysicsCase::DemagDmi) {
        require((fused.required_operator_mask & FULLMAG_FDM_OPERATOR_DMI) != 0 &&
                    (unfused.required_operator_mask &
                        FULLMAG_FDM_OPERATOR_DMI) != 0,
                "DMI operator is absent from pipeline identity");
    }
    if (physics_case == PhysicsCase::DemagDmi) {
        require((fused.required_operator_mask & FULLMAG_FDM_OPERATOR_DEMAG) != 0 &&
                    fused.setup_fft_plan_creation_count > 0 &&
                    fused.demag_evaluations > 0 &&
                    fused.demag_evaluations == fused.demag_forward_ffts &&
                    fused.demag_evaluations == fused.demag_inverse_ffts,
                "demag FFT execution is absent from pipeline evidence");
    }

    const double tolerance = precision == FULLMAG_FDM_PRECISION_DOUBLE
        ? 1.0e-10 : 2.0e-2;
    require(max_difference(fused.field, unfused.field) <= tolerance,
            "fused/unfused effective-field parity failed");
    require(max_difference(fused.rhs, unfused.rhs) <= tolerance,
            "fused/unfused RHS parity failed");
    require(max_difference(fused.magnetization, unfused.magnetization) <=
                tolerance,
            "fused/unfused trajectory parity failed");

    std::printf("PASS %s %s %s fused=%llu stages=%llu\n",
                physics_case_name(physics_case),
                integrator_name(integrator),
                precision == FULLMAG_FDM_PRECISION_DOUBLE ? "fp64" : "fp32",
                static_cast<unsigned long long>(fused.fused_launches),
                static_cast<unsigned long long>(stages));
}

void qualify_precision_pair(
    fullmag_fdm_integrator integrator,
    PhysicsCase physics_case = PhysicsCase::Base)
{
    const uint32_t step_count =
        integrator == FULLMAG_FDM_INTEGRATOR_ABM3 ? 4U : 1U;
    const auto fp64 = run_once(
        integrator, FULLMAG_FDM_PRECISION_DOUBLE, false, false, step_count,
        physics_case);
    const auto fp32 = run_once(
        integrator, FULLMAG_FDM_PRECISION_SINGLE, false, false, step_count,
        physics_case);
    const double field_error = max_scaled_difference(fp64.field, fp32.field);
    const double rhs_error = max_scaled_difference(fp64.rhs, fp32.rhs);
    const double step_error =
        max_scaled_difference(fp64.magnetization, fp32.magnetization);
    require(field_error <= 2.0e-5,
            "FP32/FP64 effective-field parity budget exceeded");
    require(rhs_error <= 2.0e-5,
            "FP32/FP64 RHS parity budget exceeded");
    require(step_error <= 2.0e-5,
            "FP32/FP64 accepted-step parity budget exceeded");
    require(fp32.peak_vram_bytes < fp64.peak_vram_bytes,
            "FP32 policy did not reduce peak VRAM for the same workload");
    std::printf(
        "PASS precision-pair %s %s field=%.6e rhs=%.6e step=%.6e "
        "vram=(%llu,%llu)\n",
        physics_case_name(physics_case), integrator_name(integrator),
        field_error, rhs_error, step_error,
        static_cast<unsigned long long>(fp64.peak_vram_bytes),
        static_cast<unsigned long long>(fp32.peak_vram_bytes));
}

void qualify_torque_fallback_case(
    fullmag_fdm_integrator integrator,
    fullmag_fdm_precision precision)
{
    const uint32_t step_count =
        integrator == FULLMAG_FDM_INTEGRATOR_ABM3 ? 4U : 1U;
    const auto production = run_once(
        integrator, precision, false, false, step_count,
        PhysicsCase::PrescribedSot);
    const auto forced_unfused = run_once(
        integrator, precision, true, false, step_count,
        PhysicsCase::PrescribedSot);
    const uint64_t stages = expected_rhs_stage_count(integrator);
    require(production.accounting_valid == 1 &&
                forced_unfused.accounting_valid == 1,
            "torque fallback accounting is invalid");
    require(production.requested_policy ==
                FULLMAG_FDM_LOCAL_PIPELINE_POLICY_AUTO_SAFE &&
                production.resolved_realization ==
                    FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_DIRECT_UNFUSED &&
                production.executed_realization ==
                    FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_DIRECT_UNFUSED,
            "torque fallback was not reported as direct unfused");
    require(production.fused_launches == 0 &&
                production.unfused_field_launches == stages &&
                production.unfused_rhs_launches == stages &&
                forced_unfused.fused_launches == 0 &&
                forced_unfused.unfused_field_launches == stages &&
                forced_unfused.unfused_rhs_launches == stages,
            "torque fallback launch accounting does not match tableau stages");
    require((production.active_feature_mask &
                FULLMAG_FDM_LOCAL_PIPELINE_FEATURE_SOT) != 0,
            "SOT fallback is absent from pipeline identity");
    const double tolerance = precision == FULLMAG_FDM_PRECISION_DOUBLE
        ? 1.0e-10 : 2.0e-2;
    require(max_difference(
                production.field, forced_unfused.field) <= tolerance &&
                max_difference(
                    production.rhs, forced_unfused.rhs) <= tolerance &&
                max_difference(
                    production.magnetization,
                    forced_unfused.magnetization) <= tolerance,
            "torque fallback diverges from the explicit unfused oracle");
    std::printf(
        "PASS prescribed-sot fallback %s %s stages=%llu\n",
        integrator_name(integrator),
        precision == FULLMAG_FDM_PRECISION_DOUBLE ? "fp64" : "fp32",
        static_cast<unsigned long long>(stages));
}

void qualify_graph_case(
    fullmag_fdm_integrator integrator,
    fullmag_fdm_precision precision)
{
    const auto fused = run_once(integrator, precision, false, true, 1);
    const auto unfused = run_once(integrator, precision, true, true, 1);
    const uint64_t stages = expected_rhs_stage_count(integrator);
    require(integrator == FULLMAG_FDM_INTEGRATOR_RK23 ||
                integrator == FULLMAG_FDM_INTEGRATOR_DP45,
            "CUDA Graph contract requires an adaptive integrator");
    require(fused.accounting_valid == 1 && unfused.accounting_valid == 1 &&
                fused.resolved_realization ==
                    FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_CUDA_GRAPH_FUSED &&
                fused.executed_realization ==
                    FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_CUDA_GRAPH_FUSED &&
                unfused.resolved_realization ==
                    FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_CUDA_GRAPH_UNFUSED &&
                unfused.executed_realization ==
                    FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_CUDA_GRAPH_UNFUSED,
            "CUDA Graph requested/resolved/executed realization mismatch");
    require(fused.fused_launches == 0 &&
                fused.unfused_field_launches == 0 &&
                fused.unfused_rhs_launches == 0 &&
                unfused.fused_launches == 0 &&
                unfused.unfused_field_launches == 0 &&
                unfused.unfused_rhs_launches == 0,
            "CUDA Graph contract mixed captured nodes with direct launches");
    require(fused.captured_fused_nodes == stages &&
                fused.captured_unfused_field_nodes == 0 &&
                fused.captured_unfused_rhs_nodes == 0,
            "fused CUDA Graph body does not match tableau stages");
    require(unfused.captured_fused_nodes == 0 &&
                unfused.captured_unfused_field_nodes == stages &&
                unfused.captured_unfused_rhs_nodes == stages,
            "unfused CUDA Graph oracle does not match tableau stages");
    std::printf(
        "TRACE graph %s %s fused=(build=%llu,launch=%llu,nodes=%llu) "
        "unfused=(build=%llu,launch=%llu,field=%llu,rhs=%llu)\n",
        integrator_name(integrator),
        precision == FULLMAG_FDM_PRECISION_DOUBLE ? "fp64" : "fp32",
        static_cast<unsigned long long>(fused.graph_builds),
        static_cast<unsigned long long>(fused.graph_launches),
        static_cast<unsigned long long>(fused.captured_fused_nodes),
        static_cast<unsigned long long>(unfused.graph_builds),
        static_cast<unsigned long long>(unfused.graph_launches),
        static_cast<unsigned long long>(unfused.captured_unfused_field_nodes),
        static_cast<unsigned long long>(unfused.captured_unfused_rhs_nodes));
    require(fused.graph_builds == 1 && fused.graph_launches == 1 &&
                unfused.graph_builds == 1 && unfused.graph_launches == 1,
            "CUDA Graph lifecycle accounting is inconsistent");
    require(fused.graph_recaptures == 0 && unfused.graph_recaptures == 0 &&
                fused.graph_attempts == 1 && unfused.graph_attempts == 1 &&
                fused.graph_fused_executions == stages &&
                fused.graph_unfused_field_executions == 0 &&
                fused.graph_unfused_rhs_executions == 0 &&
                unfused.graph_fused_executions == 0 &&
                unfused.graph_unfused_field_executions == stages &&
                unfused.graph_unfused_rhs_executions == stages,
            "CUDA Graph executed-node accounting is inconsistent");

    const double tolerance = precision == FULLMAG_FDM_PRECISION_DOUBLE
        ? 1.0e-10 : 2.0e-2;
    require(max_difference(fused.field, unfused.field) <= tolerance,
            "CUDA Graph fused/unfused effective-field parity failed");
    require(max_difference(fused.rhs, unfused.rhs) <= tolerance,
            "CUDA Graph fused/unfused RHS parity failed");
    require(max_difference(fused.magnetization, unfused.magnetization) <=
                tolerance,
            "CUDA Graph fused/unfused trajectory parity failed");

    std::printf(
        "PASS graph %s %s fused_nodes=%llu graph_launches=%llu\n",
        integrator_name(integrator),
        precision == FULLMAG_FDM_PRECISION_DOUBLE ? "fp64" : "fp32",
        static_cast<unsigned long long>(fused.captured_fused_nodes),
        static_cast<unsigned long long>(fused.graph_launches));
}

void qualify_graph_recapture_case(
    fullmag_fdm_integrator integrator,
    fullmag_fdm_precision precision)
{
    require(integrator == FULLMAG_FDM_INTEGRATOR_RK23 ||
                integrator == FULLMAG_FDM_INTEGRATOR_DP45,
            "CUDA Graph recapture requires an adaptive integrator");
    constexpr uint32_t nx = 4;
    constexpr uint64_t cell_count = nx;
    constexpr double dt = 2.5e-14;
    std::vector<double> magnetization = {
        0.8, 0.6, 0.0,
        0.0, 1.0, 0.0,
        0.6, 0.0, 0.8,
        1.0, 0.0, 0.0,
    };
    const std::array<uint8_t, cell_count> active_mask = {1, 1, 1, 1};
    std::vector<double> first_profile = {
        2.0e3, -1.0e3, 0.5e3,
        1.0e3, 0.5e3, -0.25e3,
        -0.5e3, 1.5e3, 0.75e3,
        0.25e3, -0.75e3, 1.25e3,
    };
    auto second_profile = first_profile;
    second_profile[0] += 3.0e3;

    fullmag_fdm_plan_desc plan{};
    plan.grid = {nx, 1, 1, 2e-9, 2e-9, 2e-9};
    plan.material = {8.0e5, 1.0e-30, 0.12, 2.211e5};
    plan.precision = precision;
    plan.integrator = integrator;
    plan.initial_magnetization_xyz = magnetization.data();
    plan.initial_magnetization_len = magnetization.size();
    plan.active_mask = active_mask.data();
    plan.active_mask_len = active_mask.size();
    plan.adaptive_max_error = 1.0;
    plan.adaptive_dt_min = dt;
    plan.adaptive_dt_max = dt;
    plan.adaptive_headroom = 0.8;
    plan.stats_mode = FULLMAG_FDM_STATS_NONE;

    auto *handle = fullmag_fdm_backend_create(&plan);
    require(handle != nullptr, "graph-recapture backend creation returned null");
    require(fullmag_fdm_backend_last_error(handle) == nullptr,
            "graph-recapture backend creation failed");
    require(fullmag_fdm_backend_set_static_external_field_f64(
                handle, first_profile.data(), first_profile.size()) ==
                FULLMAG_FDM_OK,
            "initial graph-recapture field upload failed");
    fullmag_fdm_step_stats stats{};
    require(fullmag_fdm_backend_step(handle, dt, &stats) == FULLMAG_FDM_OK,
            "initial graph-recapture step failed");

    auto query = [handle]() {
        fullmag_fdm_local_pipeline_telemetry_v1 telemetry{};
        telemetry.abi_version = FULLMAG_FDM_LOCAL_PIPELINE_TELEMETRY_ABI_V1;
        telemetry.struct_size = sizeof(telemetry);
        require(fullmag_fdm_backend_get_local_pipeline_telemetry_v1(
                    handle, &telemetry) == FULLMAG_FDM_OK,
                "graph-recapture telemetry query failed");
        return telemetry;
    };
    const auto before = query();
    require(fullmag_fdm_backend_set_static_external_field_f64(
                handle, second_profile.data(), second_profile.size()) ==
                FULLMAG_FDM_OK,
            "graph-recapture field mutation failed");
    require(fullmag_fdm_backend_step(handle, dt, &stats) == FULLMAG_FDM_OK,
            "recaptured graph step failed");
    const auto after = query();
    const uint64_t stages = expected_rhs_stage_count(integrator);

    require(before.source_revision + 1 == after.source_revision &&
                before.field_revision + 1 == after.field_revision,
            "public field mutation did not advance graph-key revisions");
    require(before.graph_build_count == 1 &&
                before.graph_replay_count == 1 &&
                before.graph_recapture_count == 0 &&
                after.graph_build_count == 2 &&
                after.graph_replay_count == 2 &&
                after.graph_recapture_count == 1,
            "field revision change did not cause exactly one graph recapture");
    require(before.captured_fused_field_rhs_node_count == stages &&
                after.captured_fused_field_rhs_node_count == 2 * stages &&
                after.captured_unfused_effective_field_node_count == 0 &&
                after.captured_unfused_rhs_node_count == 0,
            "recaptured fused graph node accounting is inconsistent");
    require(after.graph_attempt_execution_count == 2 &&
                after.graph_fused_field_rhs_execution_count == 2 * stages &&
                after.graph_unfused_effective_field_execution_count == 0 &&
                after.graph_unfused_rhs_execution_count == 0 &&
                after.resolved_realization ==
                    FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_CUDA_GRAPH_FUSED &&
                after.executed_realization ==
                    FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_CUDA_GRAPH_FUSED,
            "recaptured graph execution provenance is inconsistent");
    fullmag_fdm_backend_destroy(handle);
    std::printf(
        "PASS graph recapture %s %s builds=%llu revisions=(%llu,%llu)\n",
        integrator_name(integrator),
        precision == FULLMAG_FDM_PRECISION_DOUBLE ? "fp64" : "fp32",
        static_cast<unsigned long long>(after.graph_build_count),
        static_cast<unsigned long long>(after.source_revision),
        static_cast<unsigned long long>(after.field_revision));
}

} // namespace

int main() {
    const std::array<fullmag_fdm_integrator, 5> integrators = {
        FULLMAG_FDM_INTEGRATOR_HEUN,
        FULLMAG_FDM_INTEGRATOR_RK4,
        FULLMAG_FDM_INTEGRATOR_RK23,
        FULLMAG_FDM_INTEGRATOR_DP45,
        FULLMAG_FDM_INTEGRATOR_ABM3,
    };
    for (const auto integrator : integrators) {
        qualify_case(integrator, FULLMAG_FDM_PRECISION_DOUBLE);
        qualify_case(integrator, FULLMAG_FDM_PRECISION_SINGLE);
        qualify_case(
            integrator,
            FULLMAG_FDM_PRECISION_DOUBLE,
            PhysicsCase::DynamicOersted);
        qualify_case(
            integrator,
            FULLMAG_FDM_PRECISION_SINGLE,
            PhysicsCase::DynamicOersted);
        qualify_case(
            integrator,
            FULLMAG_FDM_PRECISION_DOUBLE,
            PhysicsCase::Dmi);
        qualify_case(
            integrator,
            FULLMAG_FDM_PRECISION_SINGLE,
            PhysicsCase::Dmi);
        qualify_case(
            integrator,
            FULLMAG_FDM_PRECISION_DOUBLE,
            PhysicsCase::DemagDmi);
        qualify_case(
            integrator,
            FULLMAG_FDM_PRECISION_SINGLE,
            PhysicsCase::DemagDmi);
        qualify_torque_fallback_case(
            integrator, FULLMAG_FDM_PRECISION_DOUBLE);
        qualify_torque_fallback_case(
            integrator, FULLMAG_FDM_PRECISION_SINGLE);
        qualify_precision_pair(integrator);
        qualify_precision_pair(integrator, PhysicsCase::Dmi);
        qualify_precision_pair(integrator, PhysicsCase::DemagDmi);
    }
    // Full statistics performs an additional effective-field observation after
    // the accepted step. It must not be reported as an unfused solver stage.
    qualify_case(
        FULLMAG_FDM_INTEGRATOR_HEUN,
        FULLMAG_FDM_PRECISION_DOUBLE,
        PhysicsCase::Base,
        FULLMAG_FDM_STATS_FULL);
    qualify_case(
        FULLMAG_FDM_INTEGRATOR_HEUN,
        FULLMAG_FDM_PRECISION_SINGLE,
        PhysicsCase::Base,
        FULLMAG_FDM_STATS_FULL);
    for (const auto integrator : {
             FULLMAG_FDM_INTEGRATOR_RK23,
             FULLMAG_FDM_INTEGRATOR_DP45}) {
        qualify_graph_case(integrator, FULLMAG_FDM_PRECISION_DOUBLE);
        qualify_graph_case(integrator, FULLMAG_FDM_PRECISION_SINGLE);
        qualify_graph_recapture_case(
            integrator, FULLMAG_FDM_PRECISION_DOUBLE);
        qualify_graph_recapture_case(
            integrator, FULLMAG_FDM_PRECISION_SINGLE);
    }
    std::puts("FDM_GPU_PERF003_LOCAL_PIPELINE_FUSION_PASS");
    return 0;
}

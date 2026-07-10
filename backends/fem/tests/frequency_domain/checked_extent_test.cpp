#include "cpu/frequency_domain/production_cpu_driven_response.hpp"
#include "frequency_domain/gpu_device_krylov.hpp"
#include "frequency_domain/tangent_frame.hpp"
#include "frequency_domain/checked_extent.hpp"

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>

namespace fd = fullmag::fem::frequency_domain;

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

fd::FrequencyDomainStatus count_apply_calls(
    void *user_data,
    const double *,
    double *,
    char[128])
{
    auto *call_count = static_cast<std::uint64_t *>(user_data);
    ++(*call_count);
    return fd::FrequencyDomainStatus::operator_error;
}

template <typename Function>
bool child_exits_successfully(Function function)
{
    const pid_t pid = fork();
    if (pid < 0) {
        return false;
    }
    if (pid == 0) {
        const rlimit no_core{0, 0};
        setrlimit(RLIMIT_CORE, &no_core);
        alarm(2);
        _exit(function() ? 0 : 1);
    }

    int status = 0;
    return waitpid(pid, &status, 0) == pid &&
        WIFEXITED(status) &&
        WEXITSTATUS(status) == 0;
}

void overflowing_device_basis_extent_is_rejected()
{
    double storage = 0.0;
    fd::DeviceComplexVectorView view{&storage, &storage, 0};
    const std::uint64_t expected = std::uint64_t{1} << 63;

    check(
        !fd::device_complex_vector_basis_view_valid(view, expected, 2),
        "overflow basis view is accepted");

    view.n = 6;
    check(
        fd::device_complex_vector_basis_view_valid(view, 2, 3),
        "legal device basis extent must remain accepted");

    view.n = fd::kMaxFrequencyDomainWorkspaceBytes / sizeof(double) + 1;
    check(
        !fd::device_complex_vector_basis_view_valid(view, view.n, 1),
        "device basis beyond workspace cap must be rejected");
}

void checked_add_covers_boundaries()
{
    constexpr std::uint64_t max = std::numeric_limits<std::uint64_t>::max();
    const std::uint64_t inputs[] = {0, 1, max / 3, max / 2, max};
    for (const std::uint64_t input : inputs) {
        std::uint64_t out = 0;
        check(fd::checked_add_u64(input, 0, out), "boundary plus zero must fit");
        check(out == input, "boundary plus zero must be unchanged");
    }
    std::uint64_t out = 7;
    check(!fd::checked_add_u64(max, 1, out), "UINT64_MAX plus one must overflow");
    check(out == 0, "failed checked add must clear output");
}

void checked_multiply_covers_boundaries_and_two_to_63_times_two()
{
    constexpr std::uint64_t max = std::numeric_limits<std::uint64_t>::max();
    const std::uint64_t inputs[] = {0, 1, max / 3, max / 2, max};
    for (const std::uint64_t input : inputs) {
        std::uint64_t out = 0;
        check(fd::checked_mul_u64(input, 1, out), "boundary times one must fit");
        check(out == input, "boundary times one must be unchanged");
    }
    std::uint64_t out = 7;
    check(
        !fd::checked_mul_u64(std::uint64_t{1} << 63, 2, out),
        "two-to-63 times two must overflow");
    check(out == 0, "failed checked multiply must clear output");
}

void checked_add_and_multiply_match_deterministic_properties()
{
    constexpr std::uint64_t max = std::numeric_limits<std::uint64_t>::max();
    for (std::uint64_t i = 1; i <= 1024; ++i) {
        const std::uint64_t add_lhs = i * 7919;
        const std::uint64_t add_rhs = i * 104729;
        std::uint64_t out = 0;
        check(fd::checked_add_u64(add_lhs, add_rhs, out), "bounded property add must fit");
        check(out == add_lhs + add_rhs, "bounded property add must be exact");
        check(!fd::checked_add_u64(max - i, i + 1, out), "overflow property add must fail");

        const std::uint64_t multiplier = i % 97 + 2;
        check(fd::checked_mul_u64(i, multiplier, out), "bounded property multiply must fit");
        check(out == i * multiplier, "bounded property multiply must be exact");
        check(!fd::checked_mul_u64(max / multiplier + 1, multiplier, out),
              "overflow property multiply must fail");
    }
}

void checked_byte_count_rejects_overflow()
{
    std::size_t bytes = 0;
    check(fd::checked_bytes(4, sizeof(double), bytes), "small byte count must fit");
    check(bytes == 4 * sizeof(double), "small byte count must preserve size");
    check(
        !fd::checked_bytes(
            std::numeric_limits<std::uint64_t>::max(),
            sizeof(double),
            bytes),
        "oversized byte count must overflow");
    check(fd::checked_bytes_limited(8, sizeof(double), 64, bytes) == fd::CheckedExtentStatus::ok,
          "byte count at policy cap must fit");
    check(fd::checked_bytes_limited(9, sizeof(double), 64, bytes) ==
              fd::CheckedExtentStatus::policy_limit_exceeded,
          "finite byte count above cap must be a policy failure");
    check(fd::checked_bytes_limited(
              std::numeric_limits<std::uint64_t>::max(),
              sizeof(double),
              64,
              bytes) == fd::CheckedExtentStatus::arithmetic_overflow,
          "byte overflow must be distinct from policy failure");
}

void checked_offset_plus_extent_rejects_wrap_and_capacity_overrun()
{
    std::uint64_t end = 0;
    check(fd::checked_offset_extent(4, 6, 10, end), "offset plus extent at capacity must fit");
    check(end == 10, "offset plus extent must return end");
    check(!fd::checked_offset_extent(4, 7, 10, end), "offset plus extent beyond capacity must fail");
    check(
        !fd::checked_offset_extent(
            std::numeric_limits<std::uint64_t>::max(),
            1,
            std::numeric_limits<std::uint64_t>::max(),
            end),
        "offset plus extent wrap must fail");
}

void checked_krylov_layouts_cover_restart_plus_one_and_v_z_h()
{
    constexpr std::uint64_t n = 1024;
    constexpr std::uint64_t restart = 512;
    std::uint64_t restart_plus_one = 0;
    std::uint64_t v = 0;
    std::uint64_t z = 0;
    std::uint64_t h = 0;
    check(fd::checked_add_u64(restart, 1, restart_plus_one), "restart plus one must fit");
    check(fd::checked_mul_u64(n, restart_plus_one, v), "V layout must fit");
    check(fd::checked_mul_u64(n, restart, z), "Z layout must fit");
    check(fd::checked_mul_u64(restart_plus_one, restart, h), "H layout must fit");
    check(v == 525312 && z == 524288 && h == 262656, "legal V/Z/H layouts must be unchanged");

    check(
        !fd::checked_add_u64(std::numeric_limits<std::uint64_t>::max(), 1, restart_plus_one),
        "restart plus one overflow must fail");
}

void checked_node_dense_and_row_layouts_cover_boundaries()
{
    constexpr std::uint64_t max = std::numeric_limits<std::uint64_t>::max();
    std::uint64_t out = 0;
    check(fd::checked_mul_u64(max / 3, 3, out), "3N boundary must fit");
    check(!fd::checked_mul_u64(max / 3 + 1, 3, out), "3N overflow must fail");
    check(fd::checked_mul_u64(max / 2, 2, out), "2N boundary must fit");
    check(!fd::checked_mul_u64(max / 2 + 1, 2, out), "2N overflow must fail");
    check(fd::checked_mul_u64(4096, 4096, out), "small dense n*n must fit");
    check(!fd::checked_mul_u64(max, max, out), "dense n*n overflow must fail");
    check(fd::checked_add_u64(max - 1, 1, out), "row n+1 boundary must fit");
    check(!fd::checked_add_u64(max, 1, out), "row n+1 overflow must fail");
    check(fd::checked_mul_u64(64, 2048, out), "frequency-count times tangent-DOF layout must fit");
    check(out == 131072, "legal frequency response layout must be unchanged");
    check(!fd::checked_mul_u64(max / 2 + 1, 2, out),
          "frequency-count times tangent-DOF overflow must fail");

    const fd::TangentWorkspaceShape legal_shape = fd::tangent_workspace_shape(2);
    check(
        legal_shape.full_dof_count == 6 && legal_shape.tangent_dof_count == 4,
        "legal tangent workspace shape must be unchanged");
    const fd::TangentWorkspaceShape overflow_shape = fd::tangent_workspace_shape(max);
    check(
        overflow_shape.full_dof_count == 0 && overflow_shape.tangent_dof_count == 0,
        "overflowing tangent workspace shape must fail closed");
}

void active_tangent_paths_reject_oversized_extents_before_buffer_access()
{
    const std::uint64_t oversized_node_count =
        fd::kMaxFrequencyDomainWorkspaceBytes / sizeof(fd::TangentFrameNode) + 1;
    check(
        child_exits_successfully([&]() {
            const double equilibrium_xyz[3] = {0.0, 0.0, 1.0};
            fd::TangentFrameNode out_node{};
            fd::TangentFrameDiagnostics diagnostics{};
            return fd::build_tangent_frame(
                       equilibrium_xyz,
                       oversized_node_count,
                       &out_node,
                       &diagnostics) == fd::FrequencyDomainStatus::validation_error &&
                std::strstr(diagnostics.error_message, "extent") != nullptr;
        }),
        "active tangent-frame build must reject oversized extents before buffer access");

    check(
        child_exits_successfully([&]() {
            const fd::TangentFrameNode node{};
            const double full_xyz[3] = {1.0, 0.0, 0.0};
            double tangent[2] = {17.0, 19.0};
            fd::project_full_to_tangent(
                &node,
                full_xyz,
                oversized_node_count,
                tangent);
            return tangent[0] == 17.0 && tangent[1] == 19.0;
        }),
        "active tangent projection must reject oversized extents before buffer access");

    check(
        child_exits_successfully([&]() {
            const fd::TangentFrameNode node{};
            const double tangent[2] = {1.0, 0.0};
            double full_xyz[3] = {17.0, 19.0, 23.0};
            fd::lift_tangent_to_full(
                &node,
                tangent,
                oversized_node_count,
                full_xyz);
            return full_xyz[0] == 17.0 &&
                full_xyz[1] == 19.0 &&
                full_xyz[2] == 23.0;
        }),
        "active tangent lift must reject oversized extents before buffer access");

    check(
        child_exits_successfully([&]() {
            const fd::TangentFrameNode node{};
            const double full_xyz[3] = {1.0, 0.0, 0.0};
            const fd::TangentProjectionDiagnostics diagnostics =
                fd::diagnose_tangent_projection(
                    &node,
                    full_xyz,
                    oversized_node_count);
            return diagnostics.node_count == oversized_node_count &&
                diagnostics.max_normal_component_abs == 0.0 &&
                diagnostics.max_roundtrip_error == 0.0;
        }),
        "active tangent diagnostics must reject oversized extents before buffer access");

    check(
        child_exits_successfully([&]() {
            const fd::TangentFrameNode node{};
            const double full_xyz[3] = {1.0, 0.0, 0.0};
            double tangent_real[2] = {17.0, 19.0};
            double tangent_imag[2] = {23.0, 29.0};
            fd::project_cartesian_complex_to_tangent(
                &node,
                full_xyz,
                full_xyz,
                oversized_node_count,
                tangent_real,
                tangent_imag);
            return tangent_real[0] == 17.0 && tangent_real[1] == 19.0 &&
                tangent_imag[0] == 23.0 && tangent_imag[1] == 29.0;
        }),
        "active complex tangent projection must reject oversized extents before buffer access");

    check(
        child_exits_successfully([&]() {
            const fd::TangentFrameNode node{};
            const double tangent[2] = {1.0, 0.0};
            double full_real[3] = {17.0, 19.0, 23.0};
            double full_imag[3] = {29.0, 31.0, 37.0};
            fd::lift_tangent_complex_to_cartesian(
                &node,
                tangent,
                tangent,
                oversized_node_count,
                full_real,
                full_imag);
            return full_real[0] == 17.0 &&
                full_real[1] == 19.0 &&
                full_real[2] == 23.0 &&
                full_imag[0] == 29.0 &&
                full_imag[1] == 31.0 &&
                full_imag[2] == 37.0;
        }),
        "active complex tangent lift must reject oversized extents before buffer access");
}

void active_tangent_paths_preserve_legal_small_layouts()
{
    const double equilibrium_xyz[3] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(
            equilibrium_xyz,
            1,
            &node,
            &frame_diagnostics) == fd::FrequencyDomainStatus::ok,
        "legal tangent-frame build must remain accepted");

    const double full_xyz[3] = {1.0, 0.0, 0.0};
    double tangent[2] = {0.0, 0.0};
    fd::project_full_to_tangent(&node, full_xyz, 1, tangent);
    check(tangent[0] == 1.0 && tangent[1] == 0.0,
          "legal tangent projection must remain unchanged");

    double lifted[3] = {0.0, 0.0, 0.0};
    fd::lift_tangent_to_full(&node, tangent, 1, lifted);
    check(lifted[0] == 1.0 && lifted[1] == 0.0 && lifted[2] == 0.0,
          "legal tangent lift must remain unchanged");

    const fd::TangentProjectionDiagnostics projection_diagnostics =
        fd::diagnose_tangent_projection(&node, full_xyz, 1);
    check(projection_diagnostics.max_normal_component_abs == 0.0 &&
              projection_diagnostics.max_roundtrip_error == 0.0,
          "legal tangent diagnostics must remain unchanged");
}

void checked_cuda_grid_conversion_and_policy_caps_are_distinct()
{
    std::uint32_t blocks = 0;
    check(fd::checked_cuda_grid_u32(1, 256, 1024, blocks) == fd::CheckedExtentStatus::ok,
          "one CUDA work item must fit one block");
    check(blocks == 1, "one CUDA work item must use one block");
    check(fd::checked_cuda_grid_u32(257, 256, 1024, blocks) == fd::CheckedExtentStatus::ok,
          "CUDA grid must round up without wrapping");
    check(blocks == 2, "CUDA grid must round up to two blocks");
    check(fd::checked_cuda_grid_u32(1025, 1, 1024, blocks) == fd::CheckedExtentStatus::policy_limit_exceeded,
          "CUDA grid beyond configured cap must be a policy failure");

    std::uint64_t out = 0;
    check(fd::checked_mul_u64_limited(8, 8, 64, out) == fd::CheckedExtentStatus::ok,
          "extent at policy limit must fit");
    check(fd::checked_mul_u64_limited(8, 9, 64, out) == fd::CheckedExtentStatus::policy_limit_exceeded,
          "finite extent beyond policy limit must be distinct");
    check(fd::checked_mul_u64_limited(
              std::numeric_limits<std::uint64_t>::max(), 2, 64, out) ==
              fd::CheckedExtentStatus::arithmetic_overflow,
          "arithmetic overflow must be distinct from policy limit");
}

void production_cpu_rejects_extents_before_callbacks_or_allocation()
{
    double frequency_hz = 1.0;
    double drive = 1.0;
    std::uint64_t call_count = 0;
    fd::ProductionCpuDrivenResponseProblem problem{};
    problem.tangent_dof_count = std::uint64_t{1} << 63;
    problem.frequencies_hz = &frequency_hz;
    problem.frequency_count = 2;
    problem.drive_real = &drive;
    problem.apply_stiffness = count_apply_calls;
    problem.apply_mass = count_apply_calls;
    problem.operator_user_data = &call_count;
    problem.max_iterations = 1;
    problem.restart_iterations = 1;
    fd::ProductionCpuDrivenResponseResult result{};

    check(
        fd::solve_production_cpu_driven_response(problem, &result) ==
            fd::FrequencyDomainStatus::validation_error,
        "overflowing CPU response extent must return validation error");
    check(call_count == 0, "overflowing CPU response extent must reject before callbacks");

    problem.tangent_dof_count = 1;
    problem.frequency_count = 1;
    problem.max_iterations = fd::kMaxFrequencyDomainKrylovRestartDimension + 1;
    problem.restart_iterations = fd::kMaxFrequencyDomainKrylovRestartDimension + 1;
    check(
        fd::solve_production_cpu_driven_response(problem, &result) ==
            fd::FrequencyDomainStatus::validation_error,
        "CPU restart beyond policy cap must return validation error");
    check(call_count == 0, "CPU restart beyond policy cap must reject before callbacks");
}

void production_cpu_rejects_caller_owned_array_bytes_before_callbacks()
{
    double frequencies_hz[2] = {1.0, 2.0};
    double drive[2] = {1.0, 0.0};
    double response = 0.0;
    double residual = 0.0;
    std::uint64_t call_count = 0;
    fd::ProductionCpuDrivenResponseProblem problem{};
    problem.tangent_dof_count = 1;
    problem.frequencies_hz = frequencies_hz;
    problem.frequency_count = std::numeric_limits<std::uint64_t>::max();
    problem.drive_real = drive;
    problem.apply_stiffness = count_apply_calls;
    problem.apply_mass = count_apply_calls;
    problem.operator_user_data = &call_count;
    problem.max_iterations = 1;
    problem.restart_iterations = 1;
    problem.out_response_real = &response;
    problem.out_response_imag = &response;
    problem.response_capacity = std::numeric_limits<std::uint64_t>::max();
    problem.out_residual_l2_norm = &residual;
    problem.out_relative_residual_l2_norm = &residual;
    problem.residual_capacity = std::numeric_limits<std::uint64_t>::max();
    fd::ProductionCpuDrivenResponseResult result{};

    check(
        fd::solve_production_cpu_driven_response(problem, &result) ==
            fd::FrequencyDomainStatus::validation_error,
        "CPU caller-owned byte overflow must return validation error");
    check(call_count == 0,
          "CPU caller-owned byte overflow must reject before callbacks");

    call_count = 0;
    problem.tangent_dof_count = 2;
    problem.frequency_count =
        fd::kMaxFrequencyDomainWorkspaceBytes / sizeof(double);
    std::uint64_t response_value_count = 0;
    check(fd::checked_mul_u64(
              problem.tangent_dof_count,
              problem.frequency_count,
              response_value_count),
          "response policy test product must fit uint64");
    problem.response_capacity = response_value_count;
    problem.residual_capacity = problem.frequency_count;

    check(
        fd::solve_production_cpu_driven_response(problem, &result) ==
            fd::FrequencyDomainStatus::validation_error,
        "CPU optional response bytes beyond policy must return validation error");
    check(call_count == 0,
          "CPU optional response bytes beyond policy must reject before callbacks");
}

} // namespace

int main()
{
    overflowing_device_basis_extent_is_rejected();
    checked_add_covers_boundaries();
    checked_multiply_covers_boundaries_and_two_to_63_times_two();
    checked_add_and_multiply_match_deterministic_properties();
    checked_byte_count_rejects_overflow();
    checked_offset_plus_extent_rejects_wrap_and_capacity_overrun();
    checked_krylov_layouts_cover_restart_plus_one_and_v_z_h();
    checked_node_dense_and_row_layouts_cover_boundaries();
    active_tangent_paths_reject_oversized_extents_before_buffer_access();
    active_tangent_paths_preserve_legal_small_layouts();
    checked_cuda_grid_conversion_and_policy_caps_are_distinct();
    production_cpu_rejects_extents_before_callbacks_or_allocation();
    production_cpu_rejects_caller_owned_array_bytes_before_callbacks();
    return 0;
}

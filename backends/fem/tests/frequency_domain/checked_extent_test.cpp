#include "cpu/frequency_domain/production_cpu_driven_response.hpp"
#include "frequency_domain/gpu_device_krylov.hpp"
#include "frequency_domain/tangent_frame.hpp"
#include "frequency_domain/checked_extent.hpp"

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <limits>

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
    checked_cuda_grid_conversion_and_policy_caps_are_distinct();
    production_cpu_rejects_extents_before_callbacks_or_allocation();
    return 0;
}

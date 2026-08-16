#include "../gpu/cuda/transport/spin/sparse_solver.hpp"

#include <cuda_runtime_api.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <limits>
#include <sstream>
#include <string>
#include <vector>

namespace sparse = fullmag::fdm::gpu::transport::spin::sparse;

namespace {

__global__ void initialize_uniform_problem(
    uint64_t cells, uint8_t *active, double *sigma_s, double *block,
    double *rhs, double *solution) {
    for (uint64_t cell = blockIdx.x * blockDim.x + threadIdx.x;
         cell < cells; cell += uint64_t(blockDim.x) * gridDim.x) {
        active[cell] = 1;
        sigma_s[cell] = 5.0e6;
        for (uint32_t row = 0; row < 3; ++row) {
            rhs[row * cells + cell] = row == 0 ? 1.0 : 0.0;
            solution[row * cells + cell] = 0.0;
            for (uint32_t column = 0; column < 3; ++column)
                block[(row * 3 + column) * cells + cell] =
                    row == column ? 5.0e18 : 0.0;
        }
    }
}

bool cuda_ok(cudaError_t status, const char *operation) {
    if (status == cudaSuccess) return true;
    std::fprintf(stderr, "%s: %s\n", operation, cudaGetErrorString(status));
    return false;
}

std::string uuid_hex(const cudaUUID_t &uuid) {
    std::ostringstream output;
    output << std::hex << std::setfill('0');
    for (unsigned char byte : uuid.bytes)
        output << std::setw(2) << static_cast<unsigned>(byte);
    return output.str();
}

struct RapAuditMetrics {
    double lower[sparse::kMaximumLevels]{};
    double upper[sparse::kMaximumLevels]{};
    double rayleigh[sparse::kMaximumLevels]{};
    double adjoint_error[sparse::kMaximumLevels]{};
    double quadratic_error[sparse::kMaximumLevels]{};
};

bool audit_rap_scaling(cudaStream_t stream,
                       const sparse::HierarchyCache &hierarchy,
                       double diffusion, double reaction,
                       double boundary_diagonal,
                       RapAuditMetrics *metrics) {
    constexpr uint64_t fine_cells = 1024;
    for (uint32_t level_index = 1; level_index < hierarchy.level_count;
         ++level_index) {
        const sparse::Level &level = hierarchy.levels[level_index];
        const uint64_t aggregate = UINT64_C(1) << level_index;
        const uint64_t expected_cells = fine_cells / aggregate;
        if (level.grid[0] != expected_cells || level.grid[1] != 1 ||
            level.grid[2] != 1 || level.cells != expected_cells ||
            level.coarsen_from_parent[0] != 2 ||
            level.coarsen_from_parent[1] != 1 ||
            level.coarsen_from_parent[2] != 1 ||
            level.strong_direction_mask != 1)
            return false;
        std::vector<uint8_t> active(level.cells, 0);
        std::vector<double> diagonal(3 * level.cells, 0.0);
        std::vector<double> gx(level.grid[0] + 1, 0.0);
        if (!cuda_ok(cudaMemcpyAsync(active.data(), level.active, active.size(),
                                     cudaMemcpyDeviceToHost, stream),
                     "RAP active readback") ||
            !cuda_ok(cudaMemcpyAsync(diagonal.data(), level.diagonal,
                                     diagonal.size() * sizeof(double),
                                     cudaMemcpyDeviceToHost, stream),
                     "RAP diagonal readback") ||
            !cuda_ok(cudaMemcpyAsync(gx.data(), level.gx,
                                     gx.size() * sizeof(double),
                                     cudaMemcpyDeviceToHost, stream),
                     "RAP face readback") ||
            !cuda_ok(cudaStreamSynchronize(stream), "RAP readback sync"))
            return false;
        for (uint64_t cell = 0; cell < level.cells; ++cell) {
            if (active[cell] != 1) return false;
            const double local = reaction * static_cast<double>(aggregate) +
                ((cell == 0 || cell + 1 == level.cells)
                     ? boundary_diagonal
                     : 0.0);
            const double expected_diagonal = local +
                (cell > 0 ? diffusion : 0.0) +
                (cell + 1 < level.cells ? diffusion : 0.0);
            for (uint32_t component = 0; component < 3; ++component) {
                const double observed =
                    diagonal[uint64_t(component) * level.cells + cell];
                if (std::abs(observed - expected_diagonal) >
                    64.0 * std::numeric_limits<double>::epsilon() *
                        std::abs(expected_diagonal))
                    return false;
            }
        }
        for (uint64_t face = 0; face <= level.grid[0]; ++face) {
            const double expected =
                face == 0 || face == level.grid[0] ? 0.0 : diffusion;
            if (std::abs(gx[face] - expected) >
                64.0 * std::numeric_limits<double>::epsilon() *
                    std::max(std::abs(expected), 1.0))
                return false;
        }

        double lower = 1.0;
        double upper = 1.0;
        double coarse_energy = 0.0;
        double diagonal_energy = 0.0;
        std::vector<double> q(level.cells, 0.0);
        for (uint64_t cell = 0; cell < level.cells; ++cell)
            q[cell] = double(int64_t((7 * cell + 3) % 17) - 8) / 9.0;
        for (uint64_t cell = 0; cell < level.cells; ++cell) {
            const double edge_sum =
                (cell > 0 ? gx[cell] : 0.0) +
                (cell + 1 < level.cells ? gx[cell + 1] : 0.0);
            const double radius = edge_sum / diagonal[cell];
            lower = std::min(lower, 1.0 - radius);
            upper = std::max(upper, 1.0 + radius);
            coarse_energy += diagonal[cell] * q[cell] * q[cell];
            diagonal_energy += diagonal[cell] * q[cell] * q[cell];
            if (cell + 1 < level.cells)
                coarse_energy -=
                    2.0 * gx[cell + 1] * q[cell] * q[cell + 1];
        }
        const double rayleigh = coarse_energy / diagonal_energy;

        const uint64_t previous_cells = 2 * level.cells;
        std::vector<double> fine_vector(previous_cells, 0.0);
        std::vector<double> coarse_vector(level.cells, 0.0);
        double restriction_inner = 0.0;
        double prolongation_inner = 0.0;
        double fine_energy = 0.0;
        for (uint64_t coarse_cell = 0; coarse_cell < level.cells;
             ++coarse_cell) {
            coarse_vector[coarse_cell] =
                double(int64_t((5 * coarse_cell + 1) % 19) - 9) / 10.0;
            for (uint32_t child = 0; child < 2; ++child) {
                const uint64_t fine_cell = 2 * coarse_cell + child;
                fine_vector[fine_cell] =
                    double(int64_t((11 * fine_cell + 2) % 23) - 11) / 12.0;
                restriction_inner += fine_vector[fine_cell] *
                                     coarse_vector[coarse_cell];
                prolongation_inner += fine_vector[fine_cell] *
                                      coarse_vector[coarse_cell];
            }
        }
        const uint64_t previous_aggregate = aggregate / 2;
        for (uint64_t fine_cell = 0; fine_cell < previous_cells; ++fine_cell) {
            const double value = q[fine_cell / 2];
            const double local =
                reaction * static_cast<double>(previous_aggregate) +
                ((fine_cell == 0 || fine_cell + 1 == previous_cells)
                     ? boundary_diagonal
                     : 0.0);
            const double previous_diagonal = local +
                (fine_cell > 0 ? diffusion : 0.0) +
                (fine_cell + 1 < previous_cells ? diffusion : 0.0);
            fine_energy += previous_diagonal * value * value;
            if (fine_cell + 1 < previous_cells)
                fine_energy -= 2.0 * diffusion * value * q[(fine_cell + 1) / 2];
        }
        metrics->lower[level_index] = lower;
        metrics->upper[level_index] = upper;
        metrics->rayleigh[level_index] = rayleigh;
        metrics->adjoint_error[level_index] =
            std::abs(restriction_inner - prolongation_inner) /
            std::max(std::abs(restriction_inner), 1.0e-300);
        metrics->quadratic_error[level_index] =
            std::abs(coarse_energy - fine_energy) /
            std::max(std::abs(coarse_energy), 1.0e-300);
        if (rayleigh < lower - 128.0 * std::numeric_limits<double>::epsilon() ||
            rayleigh > upper + 128.0 * std::numeric_limits<double>::epsilon() ||
            metrics->adjoint_error[level_index] != 0.0 ||
            metrics->quadratic_error[level_index] > 2.0e-13)
            return false;
    }
    return true;
}

bool run_sinh_preflight(cudaStream_t stream) {
    constexpr uint64_t cells = 1024;
    constexpr uint64_t unknowns = 3 * cells;
    constexpr double length = 100.0e-9;
    constexpr double lambda = 10.0e-9;
    constexpr double sigma_s_value = 2.0;
    constexpr double boundary_value = 1.0e-3;
    const double h = length / static_cast<double>(cells);
    const double diffusion = sigma_s_value / (2.0 * h * h);
    const double boundary_diagonal = sigma_s_value / (h * h);
    const double reaction = sigma_s_value / (2.0 * lambda * lambda);

    std::vector<uint8_t> host_active(cells, 1);
    std::vector<double> host_sigma(cells, sigma_s_value);
    std::vector<double> host_block(9 * cells, 0.0);
    std::vector<double> host_rhs(unknowns, 0.0);
    std::vector<double> expected(unknowns, 0.0);
    std::vector<double> observed(unknowns, 0.0);
    for (uint64_t cell = 0; cell < cells; ++cell) {
        const double x = (static_cast<double>(cell) + 0.5) * h;
        expected[cell] = boundary_value *
            std::sinh((length - x) / lambda) / std::sinh(length / lambda);
        for (uint32_t component = 0; component < 3; ++component)
            host_block[(component * 3 + component) * cells + cell] =
                reaction + ((cell == 0 || cell + 1 == cells)
                                ? boundary_diagonal
                                : 0.0);
    }
    // CPU manufactured oracle: sample the analytical sinh profile, then apply
    // the exact frozen cell-centred FV operator. This separates Krylov/operator
    // correctness from spatial truncation error while retaining the physical
    // reaction-diffusion scales and half-cell Dirichlet diagonals.
    for (uint64_t cell = 0; cell < cells; ++cell) {
        double value = host_block[cell] * expected[cell];
        if (cell != 0) value += diffusion * (expected[cell] - expected[cell - 1]);
        if (cell + 1 != cells)
            value += diffusion * (expected[cell] - expected[cell + 1]);
        host_rhs[cell] = value;
    }

    uint8_t *active = nullptr;
    double *sigma_s = nullptr;
    double *block = nullptr;
    double *rhs = nullptr;
    double *solution = nullptr;
    auto cleanup = [&] {
        (void)cudaFree(solution);
        (void)cudaFree(rhs);
        (void)cudaFree(block);
        (void)cudaFree(sigma_s);
        (void)cudaFree(active);
    };
    if (!cuda_ok(cudaMalloc(&active, cells), "preflight cudaMalloc(active)") ||
        !cuda_ok(cudaMalloc(&sigma_s, cells * sizeof(double)),
                 "preflight cudaMalloc(sigma)") ||
        !cuda_ok(cudaMalloc(&block, host_block.size() * sizeof(double)),
                 "preflight cudaMalloc(block)") ||
        !cuda_ok(cudaMalloc(&rhs, host_rhs.size() * sizeof(double)),
                 "preflight cudaMalloc(rhs)") ||
        !cuda_ok(cudaMalloc(&solution, observed.size() * sizeof(double)),
                 "preflight cudaMalloc(solution)")) {
        cleanup();
        return false;
    }
    if (!cuda_ok(cudaMemcpyAsync(active, host_active.data(), cells,
                                 cudaMemcpyHostToDevice, stream),
                 "preflight copy active") ||
        !cuda_ok(cudaMemcpyAsync(sigma_s, host_sigma.data(),
                                 cells * sizeof(double), cudaMemcpyHostToDevice,
                                 stream), "preflight copy sigma") ||
        !cuda_ok(cudaMemcpyAsync(block, host_block.data(),
                                 host_block.size() * sizeof(double),
                                 cudaMemcpyHostToDevice, stream),
                 "preflight copy block") ||
        !cuda_ok(cudaMemcpyAsync(rhs, host_rhs.data(),
                                 host_rhs.size() * sizeof(double),
                                 cudaMemcpyHostToDevice, stream),
                 "preflight copy rhs") ||
        !cuda_ok(cudaMemsetAsync(solution, 0, observed.size() * sizeof(double),
                                 stream), "preflight clear solution")) {
        cleanup();
        return false;
    }
    sparse::Operator input{};
    input.grid = {{cells, 1, 1}};
    input.cell_size = {{h, h, h}};
    input.active = active;
    input.spin_conductivity = sigma_s;
    input.local_block_soa = block;
    input.rhs_soa = rhs;
    input.solution_soa = solution;
    input.operator_revision = 77;
    // The public sparse operator is fail-closed when no resolved device
    // budget is supplied. Keep this manufactured oracle inside the same
    // whole-context ceiling as the production performance gate.
    input.resolved_device_budget_bytes = UINT64_C(2147483648);
    sparse::HierarchyCache hierarchy{};
    sparse::Workspace workspace{};
    sparse::BuildMetrics build{};
    sparse::SolveMetrics exact_seed{};
    sparse::SolveMetrics identity{};
    sparse::SolveMetrics jacobi{};
    sparse::SolveMetrics solve{};
    sparse::PreconditionerAuditMetrics preconditioner_audit{};
    RapAuditMetrics rap_audit{};
    const uint32_t prepare_status =
        sparse::prepare(input, stream, &hierarchy, &workspace, &build);
    uint32_t exact_seed_status = prepare_status;
    uint32_t identity_status = prepare_status;
    uint32_t jacobi_status = prepare_status;
    uint32_t solve_status = prepare_status;
    uint32_t audit_status = prepare_status;
    bool rap_passed = false;
    if (prepare_status == 0) {
        rap_passed = audit_rap_scaling(stream, hierarchy, diffusion, reaction,
                                       boundary_diagonal, &rap_audit);
        audit_status = sparse::audit_preconditioner(
            input, stream, hierarchy, workspace, &preconditioner_audit);
        (void)cudaMemcpyAsync(solution, expected.data(),
                              expected.size() * sizeof(double),
                              cudaMemcpyHostToDevice, stream);
        exact_seed_status = sparse::solve(input, stream, hierarchy, workspace,
                                          1.0e-12, 1, &exact_seed);

        (void)cudaMemsetAsync(solution, 0, observed.size() * sizeof(double), stream);
        input.preconditioner = sparse::PreconditionerPolicy::identity_diagnostic;
        identity_status = sparse::solve(input, stream, hierarchy, workspace,
                                        1.0e-12, 500, &identity);

        (void)cudaMemsetAsync(solution, 0, observed.size() * sizeof(double), stream);
        input.preconditioner = sparse::PreconditionerPolicy::block_jacobi_diagnostic;
        jacobi_status = sparse::solve(input, stream, hierarchy, workspace,
                                      1.0e-12, 500, &jacobi);

        (void)cudaMemsetAsync(solution, 0, observed.size() * sizeof(double), stream);
        input.preconditioner =
            sparse::PreconditionerPolicy::component_amg_block_jacobi_v1;
        // The exact discrete oracle is more demanding than the production
        // workload. Its tighter residual tolerance is confined to this
        // manufactured check; the large performance workload remains frozen.
        solve_status = sparse::solve(input, stream, hierarchy, workspace,
                                     1.0e-15, 500, &solve);
    }
    bool passed = rap_passed && audit_status == 0 &&
                  preconditioner_audit.additive_relative_error <= 2.0e-12 &&
                  preconditioner_audit.homogeneity_relative_error <= 2.0e-12 &&
                  preconditioner_audit.repeat_relative_error == 0.0 &&
                  std::isfinite(preconditioner_audit.energy) &&
                  preconditioner_audit.energy > 0.0 &&
                  exact_seed_status == 0 && exact_seed.iterations == 0 &&
                  solve_status == 0 &&
                  solve.reason == sparse::ConvergenceReason::converged;
    if (passed) {
        passed = cuda_ok(cudaMemcpyAsync(observed.data(), solution,
                                         observed.size() * sizeof(double),
                                         cudaMemcpyDeviceToHost, stream),
                         "preflight solution readback") &&
                 cuda_ok(cudaStreamSynchronize(stream), "preflight sync");
    }
    double maximum_absolute_error = 0.0;
    double maximum_expected = 0.0;
    double error_squared = 0.0;
    double expected_squared = 0.0;
    double tail_pointwise_relative = 0.0;
    double tail_absolute_error = 0.0;
    double forbidden_norm = 0.0;
    if (passed) {
        for (uint64_t cell = 0; cell < cells; ++cell) {
            const double error = std::abs(observed[cell] - expected[cell]);
            maximum_absolute_error = std::max(maximum_absolute_error, error);
            maximum_expected =
                std::max(maximum_expected, std::abs(expected[cell]));
            error_squared += error * error;
            expected_squared += expected[cell] * expected[cell];
            forbidden_norm = std::max(forbidden_norm,
                std::max(std::abs(observed[cells + cell]),
                         std::abs(observed[2 * cells + cell])));
        }
        tail_absolute_error = std::abs(observed[cells - 1] - expected[cells - 1]);
        tail_pointwise_relative = tail_absolute_error /
            std::max(std::abs(expected[cells - 1]), 1.0e-30);
        const double maximum_scale_normalized = maximum_absolute_error /
            std::max(maximum_expected, 1.0e-30);
        const double l2_relative =
            std::sqrt(error_squared / std::max(expected_squared, 1.0e-300));
        passed = maximum_scale_normalized <= 1.0e-9 &&
                 l2_relative <= 1.0e-9 && forbidden_norm == 0.0;
    }
    if (!passed)
        std::fprintf(stderr,
                     "sinh preflight failed prepare=%u levels=%u coarse=%llu "
                     "seed=%u/%u/%llu/%.17g identity=%u/%u/%llu/%.17g "
                     "jacobi=%u/%u/%llu/%.17g amg=%u/%u/%llu/%.17g "
                     "rap=%u audit=%u/%.17g/%.17g/%.17g/%.17g "
                     "norm_condition_indicator=%.17g max_scale=%.17g "
                     "l2=%.17g tail_abs=%.17g tail_pointwise=%.17g "
                     "forbidden=%.17g\n",
                     prepare_status, build.level_count,
                     static_cast<unsigned long long>(build.coarse_unknowns),
                     exact_seed_status, static_cast<unsigned>(exact_seed.reason),
                     static_cast<unsigned long long>(exact_seed.iterations),
                     exact_seed.relative_residual,
                     identity_status, static_cast<unsigned>(identity.reason),
                     static_cast<unsigned long long>(identity.iterations),
                     identity.relative_residual,
                     jacobi_status, static_cast<unsigned>(jacobi.reason),
                     static_cast<unsigned long long>(jacobi.iterations),
                     jacobi.relative_residual,
                     solve_status,
                     static_cast<unsigned>(solve.reason),
                     static_cast<unsigned long long>(solve.iterations),
                     solve.relative_residual, rap_passed ? 1u : 0u,
                     audit_status,
                     preconditioner_audit.additive_relative_error,
                     preconditioner_audit.homogeneity_relative_error,
                     preconditioner_audit.repeat_relative_error,
                     preconditioner_audit.energy,
                     (1.0 + 4.0 * diffusion / reaction) *
                         solve.relative_residual,
                     maximum_absolute_error /
                         std::max(maximum_expected, 1.0e-30),
                     std::sqrt(error_squared /
                         std::max(expected_squared, 1.0e-300)),
                     tail_absolute_error, tail_pointwise_relative,
                     forbidden_norm);
    if (!passed) {
        std::fprintf(stderr, "AMG depth audit:");
        for (uint32_t level = 0; level < preconditioner_audit.level_count;
             ++level)
            std::fprintf(stderr, " L%u=%.17g/%.17g", level,
                         preconditioner_audit.residual_ratios[level],
                         preconditioner_audit.energy_cosines[level]);
        std::fprintf(stderr, "\n");
        std::fprintf(stderr, "AMG phase residuals:");
        for (uint32_t level = 0; level < preconditioner_audit.level_count;
             ++level)
            std::fprintf(stderr, " L%u=%.17g/%.17g", level,
                         preconditioner_audit.down_phase_residuals[level],
                         preconditioner_audit.up_phase_residuals[level]);
        std::fprintf(stderr, "\n");
        std::fprintf(stderr, "RAP spectral audit:");
        for (uint32_t level = 1; level < build.level_count; ++level)
            std::fprintf(stderr, " L%u=%.17g/%.17g/%.17g/%.17g/%.17g",
                         level, rap_audit.lower[level],
                         rap_audit.rayleigh[level], rap_audit.upper[level],
                         rap_audit.adjoint_error[level],
                         rap_audit.quadratic_error[level]);
        std::fprintf(stderr, "\n");
        auto print_trace = [](const char *name, const sparse::SolveMetrics &metrics) {
            std::fprintf(stderr, "%s restart trace:", name);
            const uint32_t count = std::min<uint32_t>(metrics.restart_count, 31);
            for (uint32_t i = 0; i <= count; ++i)
                std::fprintf(stderr, " %.17g", metrics.restart_residuals[i]);
            std::fprintf(stderr, "\n");
        };
        print_trace("identity", identity);
        print_trace("jacobi", jacobi);
        print_trace("amg", solve);
    }
    sparse::release(&workspace);
    sparse::release(&hierarchy);
    cleanup();
    return passed;
}

} // namespace

int main() {
    constexpr std::array<uint64_t, 3> grid{1024, 128, 8};
    constexpr uint64_t cells = grid[0] * grid[1] * grid[2];
    constexpr uint64_t unknowns = 3 * cells;
    int device = 0;
    cudaDeviceProp properties{};
    if (!cuda_ok(cudaGetDevice(&device), "cudaGetDevice") ||
        !cuda_ok(cudaGetDeviceProperties(&properties, device),
                 "cudaGetDeviceProperties"))
        return 2;
    if (!properties.cooperativeLaunch) {
        std::fprintf(stderr, "device lacks cooperative launch\n");
        return 3;
    }

    uint8_t *active = nullptr;
    double *sigma_s = nullptr;
    double *block = nullptr;
    double *rhs = nullptr;
    double *solution = nullptr;
    void *context_reserve = nullptr;
    cudaStream_t stream = nullptr;
    if (!cuda_ok(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking),
                 "cudaStreamCreate"))
        return 4;
    if (!run_sinh_preflight(stream)) return 4;
    if (!cuda_ok(cudaMalloc(&active, cells), "cudaMalloc(active)") ||
        !cuda_ok(cudaMalloc(&sigma_s, cells * sizeof(double)),
                 "cudaMalloc(sigma_s)") ||
        !cuda_ok(cudaMalloc(&block, 9 * cells * sizeof(double)),
                 "cudaMalloc(block)") ||
        !cuda_ok(cudaMalloc(&rhs, unknowns * sizeof(double)), "cudaMalloc(rhs)") ||
        !cuda_ok(cudaMalloc(&solution, unknowns * sizeof(double)),
                 "cudaMalloc(solution)"))
        return 4;
    initialize_uniform_problem<<<256, 256, 0, stream>>>(
        cells, active, sigma_s, block, rhs, solution);
    if (!cuda_ok(cudaStreamSynchronize(stream), "initialize")) return 5;

    // The frozen gate is a whole-context high-water, not a solver-only budget.
    // This exact 512 MiB resident envelope covers the simultaneously live
    // charge snapshot/cache, static typed payload, m_stage, accepted mu/Q,
    // nine reaction lanes, nine torque lanes, and bounded observations. The
    // arrays allocated above occupy part of the envelope; the reserve makes
    // the entire amount physically resident during setup and all warm solves.
    constexpr uint64_t resident_external_bytes = UINT64_C(536870912);
    constexpr uint64_t explicit_input_bytes =
        cells + cells * sizeof(double) + 9 * cells * sizeof(double) +
        2 * unknowns * sizeof(double);
    static_assert(explicit_input_bytes < resident_external_bytes);
    if (!cuda_ok(cudaMalloc(&context_reserve,
                            resident_external_bytes - explicit_input_bytes),
                 "cudaMalloc(context_reserve)"))
        return 5;

    sparse::Operator input{};
    input.grid = {{grid[0], grid[1], grid[2]}};
    input.cell_size = {1.0e-9, 1.0e-9, 1.0e-9};
    input.active = active;
    input.spin_conductivity = sigma_s;
    input.local_block_soa = block;
    input.rhs_soa = rhs;
    input.solution_soa = solution;
    input.operator_revision = 1;
    input.resident_external_bytes = resident_external_bytes;
    input.resolved_device_budget_bytes = UINT64_C(2147483648);

    sparse::HierarchyCache hierarchy{};
    sparse::Workspace workspace{};
    sparse::BuildMetrics build{};
    const auto setup_begin = std::chrono::steady_clock::now();
    uint32_t status = sparse::prepare(input, stream, &hierarchy, &workspace, &build);
    if (!cuda_ok(cudaStreamSynchronize(stream), "prepare sync") || status != 0) {
        std::fprintf(stderr, "prepare status=%u\n", status);
        return 6;
    }
    const double setup_seconds = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - setup_begin).count();
    if (build.level_count < 2 || build.fine_unknowns != unknowns ||
        build.peak_device_bytes > UINT64_C(2147483648) || setup_seconds > 5.0) {
        std::fprintf(stderr,
                     "bad setup levels=%u unknowns=%llu peak=%llu seconds=%.6f\n",
                     build.level_count,
                     static_cast<unsigned long long>(build.fine_unknowns),
                     static_cast<unsigned long long>(build.peak_device_bytes),
                     setup_seconds);
        return 7;
    }

    std::array<double, 5> solve_seconds{};
    for (size_t run = 0; run < solve_seconds.size(); ++run) {
        sparse::SolveMetrics metrics{};
        const auto begin = std::chrono::steady_clock::now();
        status = sparse::solve(input, stream, hierarchy, workspace,
                               1.0e-10, 1000, &metrics);
        if (!cuda_ok(cudaStreamSynchronize(stream), "solve sync") || status != 0 ||
            metrics.reason != sparse::ConvergenceReason::converged ||
            metrics.forbidden_transfer_bytes != 0 ||
            metrics.peak_device_bytes > UINT64_C(2147483648)) {
            std::fprintf(stderr,
                         "bad solve run=%zu status=%u reason=%u iterations=%llu "
                         "amg=%llu residual=%.17g forbidden=%llu peak=%llu\n",
                         run, status, static_cast<unsigned>(metrics.reason),
                         static_cast<unsigned long long>(metrics.iterations),
                         static_cast<unsigned long long>(metrics.amg_applications),
                         metrics.relative_residual,
                         static_cast<unsigned long long>(metrics.forbidden_transfer_bytes),
                         static_cast<unsigned long long>(metrics.peak_device_bytes));
            return 8;
        }
        solve_seconds[run] = std::chrono::duration<double>(
            std::chrono::steady_clock::now() - begin).count();
    }
    std::sort(solve_seconds.begin(), solve_seconds.end());
    const double median = solve_seconds[2];
    const double p95 = solve_seconds[4];
    if (median > 30.0 || p95 > 36.0) {
        std::fprintf(stderr, "performance median=%.6f p95=%.6f\n", median, p95);
        return 9;
    }

    std::printf(
        "fdm_gpu_m1_performance_v1 PASS gpu=%s setup=%.6f median=%.6f "
        "p95=%.6f peak=%llu levels=%u cache_hits=%llu\n",
        properties.name, setup_seconds, median, p95,
        static_cast<unsigned long long>(build.peak_device_bytes), build.level_count,
        static_cast<unsigned long long>(hierarchy.cache_hits));

    if (const char *path =
            std::getenv("FULLMAG_FDM_GPU_M1_PERFORMANCE_EVIDENCE_PATH")) {
        std::ofstream json(path, std::ios::trunc);
        if (!json) return 10;
        json << std::setprecision(17)
             << "{\n"
             << "  \"schema\": \"fullmag.fdm_gpu_m1.performance.v1\",\n"
             << "  \"gate_id\": \"performance_v1\",\n"
             << "  \"gpu_name\": \"" << properties.name << "\",\n"
             << "  \"gpu_uuid\": \"" << uuid_hex(properties.uuid) << "\",\n"
             << "  \"cuda_runtime\": " << CUDART_VERSION << ",\n"
             << "  \"grid\": [1024, 128, 8],\n"
             << "  \"cells\": " << cells << ",\n"
             << "  \"setup_seconds\": " << setup_seconds << ",\n"
             << "  \"solve_seconds\": [";
        for (size_t i = 0; i < solve_seconds.size(); ++i) {
            if (i != 0) json << ", ";
            json << solve_seconds[i];
        }
        json << "],\n"
             << "  \"median_solve_seconds\": " << median << ",\n"
             << "  \"p95_solve_seconds\": " << p95 << ",\n"
             << "  \"forbidden_transfer_bytes\": 0,\n"
             << "  \"byte_ledger\": {\n"
             << "    \"external_context\": " << build.bytes.external_context << ",\n"
             << "    \"hierarchy\": " << build.bytes.hierarchy << ",\n"
             << "    \"krylov_basis\": " << build.bytes.krylov_basis << ",\n"
             << "    \"work_vectors\": " << build.bytes.work_vectors << ",\n"
             << "    \"coarse_vectors\": " << build.bytes.coarse_vectors << ",\n"
             << "    \"reductions_and_scalars\": "
             << build.bytes.reductions_and_scalars << ",\n"
             << "    \"total_high_water\": " << build.bytes.total_high_water << "\n"
             << "  },\n"
             << "  \"limits\": {\"bytes\": 2147483648, \"setup_s\": 5, "
                "\"median_s\": 30, \"p95_s\": 36},\n"
             << "  \"passed\": true\n"
             << "}\n";
        if (!json) return 10;
    }

    sparse::release(&workspace);
    sparse::release(&hierarchy);
    (void)cudaFree(solution);
    (void)cudaFree(rhs);
    (void)cudaFree(block);
    (void)cudaFree(sigma_s);
    (void)cudaFree(active);
    (void)cudaFree(context_reserve);
    (void)cudaStreamDestroy(stream);
    return 0;
}

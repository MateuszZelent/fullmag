#include "gpu/cuda/relaxation/gpu_relaxation_preconditioner.hpp"

#include <cuda_runtime.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <string>
#include <vector>

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

bool close(double actual, double expected, double tolerance = 1.0e-13)
{
    return std::abs(actual - expected) <= tolerance;
}

void check_vector_close(
    const std::vector<double> &actual,
    const std::vector<double> &expected,
    const char *message)
{
    check(actual.size() == expected.size(), message);
    for (size_t i = 0; i < actual.size(); ++i) {
        check(close(actual[i], expected[i]), message);
    }
}

struct ManufacturedFullSpdMatrix {
    static constexpr size_t size = 3;
    std::array<std::array<double, size>, size> entries{};

    std::vector<double> solve(std::vector<double> rhs) const
    {
        auto a = entries;
        for (size_t pivot = 0; pivot < size; ++pivot) {
            size_t best = pivot;
            for (size_t row = pivot + 1; row < size; ++row) {
                if (std::abs(a[row][pivot]) > std::abs(a[best][pivot])) {
                    best = row;
                }
            }
            check(std::abs(a[best][pivot]) > 1.0e-15,
                  "dense SPD oracle requires a nonsingular operator");
            std::swap(a[pivot], a[best]);
            std::swap(rhs[pivot], rhs[best]);
            for (size_t row = pivot + 1; row < size; ++row) {
                const double factor = a[row][pivot] / a[pivot][pivot];
                for (size_t col = pivot; col < size; ++col) {
                    a[row][col] -= factor * a[pivot][col];
                }
                rhs[row] -= factor * rhs[pivot];
            }
        }

        std::vector<double> solution(size, 0.0);
        for (size_t reverse = 0; reverse < size; ++reverse) {
            const size_t row = size - 1 - reverse;
            double value = rhs[row];
            for (size_t col = row + 1; col < size; ++col) {
                value -= a[row][col] * solution[col];
            }
            solution[row] = value / a[row][row];
        }
        return solution;
    }
};

std::vector<double> diagonal_solution(
    const std::vector<double> &mass,
    const std::vector<double> &exchange_diagonal,
    double weight,
    const std::vector<double> &rhs)
{
    std::vector<double> solution(rhs.size(), 0.0);
    for (size_t i = 0; i < rhs.size(); ++i) {
        solution[i] = mass[i] * rhs[i] /
            (mass[i] + weight * exchange_diagonal[i]);
    }
    return solution;
}

void check_resolver_contract()
{
    using namespace fullmag::fem;

    GpuRelaxationPreconditionerDecision decision;
    std::string error;
    check(resolve_gpu_relaxation_preconditioner({}, decision, error),
          "empty request must retain the none baseline");
    check(decision.kind == GpuRelaxationPreconditionerKind::None,
          "empty request must resolve to none");
    check(std::string(gpu_relaxation_preconditioner_kind_id(decision.kind)) == "none",
          "none must retain its stable identifier");

    GpuRelaxationPreconditionerRequest diagonal{"diagonal", false, false};
    check(!resolve_gpu_relaxation_preconditioner(diagonal, decision, error),
          "unqualified diagonal profile must fail closed");
    diagonal.profile_qualified = true;
    check(resolve_gpu_relaxation_preconditioner(diagonal, decision, error),
          "qualified diagonal profile must resolve");
    check(decision.kind == GpuRelaxationPreconditionerKind::Diagonal,
          "qualified diagonal profile must have diagonal enum identity");
    check(std::string(gpu_relaxation_preconditioner_kind_id(decision.kind)) == "diagonal",
          "diagonal must have the stable diagonal identifier");

    for (const char *requested : {
             "exchange_mass", "exchange_mass_cg4", "exchange_mass_cg8"}) {
        for (bool qualified : {false, true}) {
            GpuRelaxationPreconditionerRequest request{requested, qualified, false};
            check(!resolve_gpu_relaxation_preconditioner(request, decision, error),
                  "full sparse exchange-mass profiles must remain unavailable");
            check(error.find("not implemented") != std::string::npos ||
                      error.find("unavailable") != std::string::npos,
                  "unavailable sparse profiles must return an explicit error");
        }
    }

    GpuRelaxationPreconditionerRequest unknown{"stale_unknown_profile", true, false};
    check(!resolve_gpu_relaxation_preconditioner(unknown, decision, error),
          "unknown profile must fail closed");
    diagonal.profile_stale = true;
    check(!resolve_gpu_relaxation_preconditioner(diagonal, decision, error),
          "stale diagonal profile must fail closed");
}

void check_diagonal_builder_validation()
{
    using fullmag::fem::build_gpu_relaxation_diagonal;

    std::string error;
    std::vector<double> diagonal;
    check(build_gpu_relaxation_diagonal(
              {2.0, -7.0, 5.0}, {4.0, 9.0, 2.0}, 0.5,
              {1u, 0u, 1u}, diagonal, error),
          "inactive or fixed nodes must not require positive mass");
    check_vector_close(diagonal, {4.0, 0.0, 6.0},
                       "builder must preserve heterogeneous active diagonals and mask fixed nodes");

    const double inf = std::numeric_limits<double>::infinity();
    check(!build_gpu_relaxation_diagonal({}, {}, 0.5, {}, diagonal, error),
          "empty diagonal inputs must fail");
    check(!build_gpu_relaxation_diagonal({1.0}, {1.0, 2.0}, 0.5, {}, diagonal, error),
          "mismatched diagonal dimensions must fail");
    check(!build_gpu_relaxation_diagonal({1.0}, {1.0}, 0.5, {1u, 0u}, diagonal, error),
          "mismatched mask dimensions must fail");
    check(!build_gpu_relaxation_diagonal({1.0}, {1.0}, -0.5, {}, diagonal, error),
          "negative weight must fail");
    check(!build_gpu_relaxation_diagonal({1.0}, {1.0}, inf, {}, diagonal, error),
          "non-finite weight must fail");
    check(!build_gpu_relaxation_diagonal({0.0}, {1.0}, 0.5, {1u}, diagonal, error),
          "non-positive active mass must fail");
    check(!build_gpu_relaxation_diagonal({inf}, {1.0}, 0.5, {1u}, diagonal, error),
          "non-finite mass must fail");
    check(!build_gpu_relaxation_diagonal({1.0}, {inf}, 0.5, {1u}, diagonal, error),
          "non-finite exchange diagonal must fail");
}

void check_dense_oracle_separates_diagonal_from_sparse()
{
    using namespace fullmag::fem;

    const std::vector<double> mass = {2.0, 3.0, 5.0};
    const std::vector<double> exchange_diagonal = {4.0, 3.0, 2.0};
    const double weight = 0.5;
    const std::vector<double> rhs = {1.0, -2.0, 0.5};

    ManufacturedFullSpdMatrix full_operator{{{
        {{mass[0] + weight * 4.0, weight * 1.0, weight * 0.5}},
        {{weight * 1.0, mass[1] + weight * 3.0, weight * 0.25}},
        {{weight * 0.5, weight * 0.25, mass[2] + weight * 2.0}},
    }}};
    std::vector<double> mass_rhs(rhs.size(), 0.0);
    for (size_t i = 0; i < rhs.size(); ++i) {
        mass_rhs[i] = mass[i] * rhs[i];
    }
    const std::vector<double> sparse_oracle = full_operator.solve(mass_rhs);
    const std::vector<double> expected_diagonal =
        diagonal_solution(mass, exchange_diagonal, weight, rhs);

    double difference_sq = 0.0;
    for (size_t i = 0; i < rhs.size(); ++i) {
        const double difference = expected_diagonal[i] - sparse_oracle[i];
        difference_sq += difference * difference;
    }
    check(std::sqrt(difference_sq) > 1.0e-3,
          "off-diagonal SPD oracle must distinguish diagonal apply from a full sparse solve");

    std::string error;
    GpuDiagonalRelaxationPreconditioner preconditioner;
    check(preconditioner.setup(mass, exchange_diagonal, weight, nullptr, error),
          "diagonal preconditioner setup must accept heterogeneous inputs");
    std::vector<double> actual;
    check(preconditioner.apply_host(rhs, actual, error),
          "diagonal host apply must succeed");
    check_vector_close(actual, expected_diagonal,
                       "diagonal host apply must use only M_i/(M_i+weight*K_ii)");

    double actual_sparse_difference_sq = 0.0;
    for (size_t i = 0; i < rhs.size(); ++i) {
        const double difference = actual[i] - sparse_oracle[i];
        actual_sparse_difference_sq += difference * difference;
    }
    check(std::sqrt(actual_sparse_difference_sq) > 1.0e-3,
          "diagonal implementation must not claim the full sparse oracle result");
}

void check_diagonal_host_and_device_contract()
{
    using namespace fullmag::fem;

    const std::vector<double> mass = {2.0, 3.0, 5.0};
    const std::vector<double> exchange = {4.0, 3.0, 2.0};
    const std::vector<double> rhs_x = {1.0, -2.0, 0.5};
    const std::vector<double> rhs_y = {-3.0, 0.25, 2.0};
    const std::vector<double> rhs_z = {0.0, 0.0, 0.0};
    const double weight = 0.5;
    std::string error;

    GpuDiagonalRelaxationPreconditioner preconditioner;
    std::vector<double> solution;
    check(!preconditioner.apply_host(rhs_x, solution, error),
          "host apply before setup must fail");
    check(!preconditioner.apply_device(nullptr, nullptr, mass.size(), nullptr, error),
          "device apply before setup must fail");

    check(preconditioner.setup(mass, exchange, weight, nullptr, error),
          "diagonal setup must succeed");
    check(preconditioner.setup_count() == 1, "first setup must be counted");
    check(preconditioner.is_active(), "configured diagonal preconditioner must be active");
    check(preconditioner.device_factors() != nullptr,
          "configured diagonal preconditioner must expose device factors");
    check(preconditioner.setup(mass, exchange, weight, nullptr, error),
          "identical diagonal setup must be reusable");
    check(preconditioner.setup_count() == 1,
          "identical diagonal setup must not upload a second time");

    const std::vector<double> expected_x =
        diagonal_solution(mass, exchange, weight, rhs_x);
    const std::vector<double> expected_y =
        diagonal_solution(mass, exchange, weight, rhs_y);
    check(preconditioner.apply_host(rhs_x, solution, error),
          "diagonal host apply must succeed");
    check_vector_close(solution, expected_x, "host apply must match diagonal oracle");
    check(preconditioner.apply_host(rhs_z, solution, error),
          "zero RHS host apply must succeed");
    check_vector_close(solution, rhs_z, "zero RHS must remain exactly zero");

    const double inf = std::numeric_limits<double>::infinity();
    check(!preconditioner.apply_host({1.0, 2.0}, solution, error),
          "host apply dimension mismatch must fail");
    check(!preconditioner.apply_host({1.0, inf, 2.0}, solution, error),
          "non-finite host RHS must fail");

    double *d_rhs_x = nullptr;
    double *d_rhs_y = nullptr;
    double *d_rhs_z = nullptr;
    double *d_sol_x = nullptr;
    double *d_sol_y = nullptr;
    double *d_sol_z = nullptr;
    const size_t bytes = mass.size() * sizeof(double);
    check(cudaMalloc(&d_rhs_x, bytes) == cudaSuccess, "cudaMalloc rhs x must succeed");
    check(cudaMalloc(&d_rhs_y, bytes) == cudaSuccess, "cudaMalloc rhs y must succeed");
    check(cudaMalloc(&d_rhs_z, bytes) == cudaSuccess, "cudaMalloc rhs z must succeed");
    check(cudaMalloc(&d_sol_x, bytes) == cudaSuccess, "cudaMalloc solution x must succeed");
    check(cudaMalloc(&d_sol_y, bytes) == cudaSuccess, "cudaMalloc solution y must succeed");
    check(cudaMalloc(&d_sol_z, bytes) == cudaSuccess, "cudaMalloc solution z must succeed");
    check(cudaMemcpy(d_rhs_x, rhs_x.data(), bytes, cudaMemcpyHostToDevice) == cudaSuccess,
          "copy rhs x to device must succeed");
    check(cudaMemcpy(d_rhs_y, rhs_y.data(), bytes, cudaMemcpyHostToDevice) == cudaSuccess,
          "copy rhs y to device must succeed");
    check(cudaMemcpy(d_rhs_z, rhs_z.data(), bytes, cudaMemcpyHostToDevice) == cudaSuccess,
          "copy rhs z to device must succeed");

    check(!preconditioner.apply_device(nullptr, d_sol_x, mass.size(), nullptr, error),
          "null device RHS must fail");
    check(!preconditioner.apply_device(d_rhs_x, nullptr, mass.size(), nullptr, error),
          "null device solution must fail");
    check(!preconditioner.apply_device(d_rhs_x, d_sol_x, mass.size() - 1, nullptr, error),
          "short device dimension must fail");
    check(!preconditioner.apply_device(d_rhs_x, d_sol_x, mass.size() + 1, nullptr, error),
          "long device dimension must fail");
    check(!preconditioner.apply_device_component(
              nullptr, d_rhs_y, d_rhs_z,
              d_sol_x, d_sol_y, d_sol_z,
              mass.size(), nullptr, error),
          "null component RHS must fail");
    check(!preconditioner.apply_device_component(
              d_rhs_x, d_rhs_y, d_rhs_z,
              d_sol_x, nullptr, d_sol_z,
              mass.size(), nullptr, error),
          "null component solution must fail");
    check(!preconditioner.apply_device_component(
              d_rhs_x, d_rhs_y, d_rhs_z,
              d_sol_x, d_sol_y, d_sol_z,
              mass.size() - 1, nullptr, error),
          "component dimension mismatch must fail");

    check(preconditioner.apply_device(
              d_rhs_x, d_sol_x, mass.size(), nullptr, error),
          "scalar diagonal device apply must succeed");
    std::vector<double> actual_scalar(mass.size());
    check(cudaMemcpy(actual_scalar.data(), d_sol_x, bytes, cudaMemcpyDeviceToHost) == cudaSuccess,
          "copy scalar solution from device must succeed");
    check_vector_close(actual_scalar, expected_x,
                       "scalar device apply must match diagonal oracle");

    check(preconditioner.apply_device_component(
              d_rhs_x, d_rhs_y, d_rhs_z,
              d_sol_x, d_sol_y, d_sol_z,
              mass.size(), nullptr, error),
          "x/y/z diagonal device apply must succeed");
    std::vector<double> actual_x(mass.size());
    std::vector<double> actual_y(mass.size());
    std::vector<double> actual_z(mass.size());
    check(cudaMemcpy(actual_x.data(), d_sol_x, bytes, cudaMemcpyDeviceToHost) == cudaSuccess,
          "copy solution x from device must succeed");
    check(cudaMemcpy(actual_y.data(), d_sol_y, bytes, cudaMemcpyDeviceToHost) == cudaSuccess,
          "copy solution y from device must succeed");
    check(cudaMemcpy(actual_z.data(), d_sol_z, bytes, cudaMemcpyDeviceToHost) == cudaSuccess,
          "copy solution z from device must succeed");
    check_vector_close(actual_x, expected_x, "device x must match diagonal oracle");
    check_vector_close(actual_y, expected_y, "device y must match diagonal oracle");
    check_vector_close(actual_z, rhs_z, "device z zero RHS must remain exactly zero");

    const std::vector<double> large_mass = {2.0, 3.0, 5.0, 7.0, 11.0};
    const std::vector<double> large_exchange = {4.0, 3.0, 2.0, 1.0, 0.5};
    check(preconditioner.setup(large_mass, large_exchange, weight, nullptr, error),
          "larger diagonal setup must succeed");
    check(preconditioner.setup(mass, exchange, weight, nullptr, error),
          "smaller diagonal re-setup must reuse larger capacity");
    check(preconditioner.apply_device(
              d_rhs_x, d_sol_x, mass.size(), nullptr, error),
          "scalar apply after larger-to-smaller re-setup must succeed");
    check(preconditioner.apply_device_component(
              d_rhs_x, d_rhs_y, d_rhs_z,
              d_sol_x, d_sol_y, d_sol_z,
              mass.size(), nullptr, error),
          "component apply after larger-to-smaller re-setup must succeed");
    check(!preconditioner.apply_device(
              d_rhs_x, d_sol_x, large_mass.size(), nullptr, error),
          "stale larger scalar dimension must fail after smaller re-setup");
    check(!preconditioner.apply_device_component(
              d_rhs_x, d_rhs_y, d_rhs_z,
              d_sol_x, d_sol_y, d_sol_z,
              large_mass.size(), nullptr, error),
          "stale larger component dimension must fail after smaller re-setup");

    cudaFree(d_rhs_x);
    cudaFree(d_rhs_y);
    cudaFree(d_rhs_z);
    cudaFree(d_sol_x);
    cudaFree(d_sol_y);
    cudaFree(d_sol_z);

    check(preconditioner.setup(mass, exchange, 0.0, nullptr, error),
          "weight zero setup must succeed");
    check(preconditioner.apply_host(rhs_x, solution, error),
          "weight zero host apply must succeed");
    check_vector_close(solution, rhs_x, "weight zero must produce the identity factor");

    check(!preconditioner.setup({}, {}, weight, nullptr, error),
          "empty setup must fail");
    check(!preconditioner.setup({1.0}, {1.0, 2.0}, weight, nullptr, error),
          "setup dimension mismatch must fail");
    check(!preconditioner.setup({1.0}, {1.0}, -weight, nullptr, error),
          "negative setup weight must fail");
    check(!preconditioner.setup({1.0}, {1.0}, inf, nullptr, error),
          "non-finite setup weight must fail");
    check(!preconditioner.setup({0.0}, {1.0}, weight, nullptr, error),
          "non-positive setup mass must fail");
    check(!preconditioner.setup({inf}, {1.0}, weight, nullptr, error),
          "non-finite setup mass must fail");
    check(!preconditioner.setup({1.0}, {inf}, weight, nullptr, error),
          "non-finite setup exchange diagonal must fail");

    preconditioner.reset();
    check(!preconditioner.is_active(), "reset diagonal preconditioner must be inactive");
    check(preconditioner.device_factors() == nullptr,
          "reset diagonal preconditioner must release device factors");
}

} // namespace

int main()
{
    check_resolver_contract();
    check_diagonal_builder_validation();
    check_dense_oracle_separates_diagonal_from_sparse();
    check_diagonal_host_and_device_contract();
    std::printf("PASS: gpu_relaxation_preconditioner_contract\n");
    return 0;
}

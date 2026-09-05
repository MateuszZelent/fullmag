#include "gpu/cuda/relaxation/gpu_relaxation_preconditioner.hpp"
#include "gpu/cuda/relaxation/gpu_exchange_mass_preconditioner.hpp"
#include "gpu/cuda/relaxation/pgbb_kernels.hpp"
#include "gpu/cuda/reductions/reduction_kernels.hpp"
#include "gpu/cuda/sparse/sparse_apply_plan.hpp"
#include "gpu/cuda/integrators/rk/rk_component_copy.hpp"
#include "src/relaxation_numerics.hpp"

#include <cuda_runtime.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <limits>
#include <string>
#include <tuple>
#include <type_traits>
#include <utility>
#include <vector>

namespace {

using DeviceSumFunction = cudaError_t (*)(
    const double *, int, double *, void *, size_t &, cudaStream_t);
static_assert(
    std::is_same_v<
        decltype(&fullmag::fem::fullmag_cuda_device_sum), DeviceSumFunction>,
    "device sum wrapper must return the immediate CUB CUDA status");

using DeviceMaxFunction = cudaError_t (*)(
    const double *, int, double *, void *, size_t &, cudaStream_t);
static_assert(
    std::is_same_v<
        decltype(&fullmag::fem::fullmag_cuda_device_max), DeviceMaxFunction>,
    "device max wrapper must return the immediate CUB CUDA status");

using DeviceMinFunction = cudaError_t (*)(
    const double *, int, double *, void *, size_t &, cudaStream_t);
static_assert(
    std::is_same_v<
        decltype(&fullmag::fem::fullmag_cuda_device_min), DeviceMinFunction>,
    "device min wrapper must return the immediate CUB CUDA status");

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

template <typename T>
class DeviceBuffer {
public:
    explicit DeviceBuffer(size_t count) : count_(count)
    {
        const cudaError_t status =
            cudaMalloc(reinterpret_cast<void **>(&data_), count * sizeof(T));
        if (status != cudaSuccess) {
            std::fprintf(
                stderr,
                "FAIL: cudaMalloc device test buffer (%zu bytes) failed: %s\n",
                count * sizeof(T),
                cudaGetErrorString(status));
            std::exit(1);
        }
    }

    ~DeviceBuffer()
    {
        cudaFree(data_);
    }

    DeviceBuffer(const DeviceBuffer &) = delete;
    DeviceBuffer &operator=(const DeviceBuffer &) = delete;

    T *get() const { return data_; }
    size_t size() const { return count_; }

    void copy_from(const std::vector<T> &host)
    {
        check(host.size() == count_, "device test upload size must match");
        check(cudaMemcpy(data_, host.data(), count_ * sizeof(T), cudaMemcpyHostToDevice) ==
                  cudaSuccess,
              "device test upload must succeed");
    }

    std::vector<T> copy_to_host() const
    {
        std::vector<T> host(count_);
        check(cudaMemcpy(host.data(), data_, count_ * sizeof(T), cudaMemcpyDeviceToHost) ==
                  cudaSuccess,
              "device test readback must succeed");
        return host;
    }

private:
    T *data_ = nullptr;
    size_t count_ = 0;
};

using DenseMatrix = std::vector<std::vector<double>>;

std::vector<double> solve_dense(DenseMatrix matrix, std::vector<double> rhs)
{
    const size_t n = rhs.size();
    check(matrix.size() == n, "dense oracle matrix height must match RHS");
    for (const auto &row : matrix) {
        check(row.size() == n, "dense oracle matrix must be square");
    }
    for (size_t pivot = 0; pivot < n; ++pivot) {
        size_t best = pivot;
        for (size_t row = pivot + 1; row < n; ++row) {
            if (std::abs(matrix[row][pivot]) > std::abs(matrix[best][pivot])) {
                best = row;
            }
        }
        check(std::abs(matrix[best][pivot]) > 1.0e-15,
              "dense oracle requires a nonsingular operator");
        std::swap(matrix[pivot], matrix[best]);
        std::swap(rhs[pivot], rhs[best]);
        for (size_t row = pivot + 1; row < n; ++row) {
            const double factor = matrix[row][pivot] / matrix[pivot][pivot];
            for (size_t col = pivot; col < n; ++col) {
                matrix[row][col] -= factor * matrix[pivot][col];
            }
            rhs[row] -= factor * rhs[pivot];
        }
    }
    std::vector<double> solution(n, 0.0);
    for (size_t reverse = 0; reverse < n; ++reverse) {
        const size_t row = n - 1u - reverse;
        double value = rhs[row];
        for (size_t col = row + 1u; col < n; ++col) {
            value -= matrix[row][col] * solution[col];
        }
        solution[row] = value / matrix[row][row];
    }
    return solution;
}

double relative_residual(
    const DenseMatrix &matrix,
    const std::vector<double> &solution,
    const std::vector<double> &rhs)
{
    double residual_sq = 0.0;
    double rhs_sq = 0.0;
    for (size_t row = 0; row < rhs.size(); ++row) {
        double applied = 0.0;
        for (size_t col = 0; col < rhs.size(); ++col) {
            applied += matrix[row][col] * solution[col];
        }
        const double residual = applied - rhs[row];
        residual_sq += residual * residual;
        rhs_sq += rhs[row] * rhs[row];
    }
    return std::sqrt(residual_sq / rhs_sq);
}

double residual_squared(
    const DenseMatrix &matrix,
    const std::vector<double> &solution,
    const std::vector<double> &rhs)
{
    double result = 0.0;
    for (size_t row = 0; row < rhs.size(); ++row) {
        double applied = 0.0;
        for (size_t col = 0; col < rhs.size(); ++col) {
            applied += matrix[row][col] * solution[col];
        }
        const double residual = applied - rhs[row];
        result += residual * residual;
    }
    return result;
}

double l2_error(
    const std::vector<double> &actual,
    const std::vector<double> &expected)
{
    check(actual.size() == expected.size(), "L2 error vectors must match");
    double error_sq = 0.0;
    for (size_t i = 0; i < actual.size(); ++i) {
        const double difference = actual[i] - expected[i];
        error_sq += difference * difference;
    }
    return std::sqrt(error_sq);
}

struct DeviceSparseOperator {
    DeviceSparseOperator(
        const DenseMatrix &exchange,
        fullmag::fem::SparseApplyVariant variant =
            fullmag::fem::SparseApplyVariant::ScalarRow)
        : rows(exchange.size() + 1u),
          columns(nonzero_count(exchange)),
          values(columns.size())
    {
        std::vector<uint32_t> host_rows{0u};
        std::vector<uint32_t> host_columns;
        std::vector<double> host_values;
        for (size_t row = 0; row < exchange.size(); ++row) {
            check(exchange[row].size() == exchange.size(),
                  "device sparse test operator must be square");
            for (size_t col = 0; col < exchange.size(); ++col) {
                if (exchange[row][col] != 0.0) {
                    host_columns.push_back(static_cast<uint32_t>(col));
                    host_values.push_back(exchange[row][col]);
                }
            }
            host_rows.push_back(static_cast<uint32_t>(host_values.size()));
        }
        rows.copy_from(host_rows);
        columns.copy_from(host_columns);
        values.copy_from(host_values);
        std::string error;
        check(plan.setup(
                  {rows.get(), columns.get(), values.get(),
                   static_cast<uint32_t>(exchange.size()),
                   static_cast<uint32_t>(exchange.size())},
                  nullptr,
                  error),
              "device sparse test plan setup must succeed");
        check(cudaDeviceSynchronize() == cudaSuccess,
              "odd-sized sparse plan setup must not leave an asynchronous CUDA error");
        check(plan.force_variant_for_test(variant, error),
              "device sparse test plan variant must be selectable");
    }

    static size_t nonzero_count(const DenseMatrix &matrix)
    {
        size_t count = 0;
        for (const auto &row : matrix) {
            count += static_cast<size_t>(std::count_if(
                row.begin(), row.end(), [](double value) { return value != 0.0; }));
        }
        return count;
    }

    DeviceBuffer<uint32_t> rows;
    DeviceBuffer<uint32_t> columns;
    DeviceBuffer<double> values;
    fullmag::fem::SparseApplyPlan plan;
};

DenseMatrix chain_exchange(size_t n)
{
    DenseMatrix exchange(n, std::vector<double>(n, 0.0));
    for (size_t i = 0; i < n; ++i) {
        if (i > 0u) {
            exchange[i][i - 1u] = -1.0;
            exchange[i][i] += 1.0;
        }
        if (i + 1u < n) {
            exchange[i][i + 1u] = -1.0;
            exchange[i][i] += 1.0;
        }
    }
    return exchange;
}

DenseMatrix exchange_mass_operator(
    const std::vector<double> &mass,
    const DenseMatrix &exchange,
    double weight)
{
    DenseMatrix op = exchange;
    for (size_t row = 0; row < mass.size(); ++row) {
        for (size_t col = 0; col < mass.size(); ++col) {
            op[row][col] *= weight;
        }
        op[row][row] += mass[row];
    }
    return op;
}

std::vector<double> mass_rhs(
    const std::vector<double> &mass,
    const std::vector<double> &gradient)
{
    std::vector<double> rhs(mass.size(), 0.0);
    for (size_t i = 0; i < mass.size(); ++i) {
        rhs[i] = mass[i] * gradient[i];
    }
    return rhs;
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

    GpuRelaxationPreconditionerRequest ambiguous{"exchange_mass", true, false};
    check(!resolve_gpu_relaxation_preconditioner(ambiguous, decision, error),
          "base exchange_mass token must remain ambiguous and fail closed");
    check(error.find("ambiguous") != std::string::npos,
          "ambiguous exchange_mass token must return an explicit error");

    for (const auto &[requested, fixed_iterations] :
         std::array<std::pair<const char *, uint32_t>, 2>{
             std::pair{"exchange_mass_cg4", 4u},
             std::pair{"exchange_mass_cg8", 8u}}) {
        GpuRelaxationPreconditionerRequest request{requested, false, false};
        check(!resolve_gpu_relaxation_preconditioner(request, decision, error),
              "unqualified sparse exchange-mass profile must fail closed");
        request.profile_qualified = true;
        check(resolve_gpu_relaxation_preconditioner(request, decision, error),
              "qualified sparse exchange-mass profile must resolve");
        check(decision.kind == GpuRelaxationPreconditionerKind::ExchangeMass,
              "qualified sparse profile must resolve the exchange_mass family");
        check(std::string(gpu_relaxation_preconditioner_kind_id(decision.kind)) ==
                  "exchange_mass",
              "exchange-mass family must have a stable identifier");
        check(decision.fixed_iterations == fixed_iterations,
              "exchange-mass decision must preserve exact fixed iteration count");
    }

    GpuRelaxationPreconditionerRequest unknown{"stale_unknown_profile", true, false};
    check(!resolve_gpu_relaxation_preconditioner(unknown, decision, error),
          "unknown profile must fail closed");
    diagonal.profile_stale = true;
    check(!resolve_gpu_relaxation_preconditioner(diagonal, decision, error),
          "stale diagonal profile must fail closed");
}

struct ExchangeMassResult {
    std::vector<double> x;
    std::vector<double> y;
    std::vector<double> z;
    std::array<double, 3> residual_squared{};
    uint32_t iterations = 0;
    uint32_t failure_latch = 0;
};

ExchangeMassResult apply_exchange_mass(
    fullmag::fem::GpuExchangeMassPreconditioner &preconditioner,
    const std::vector<double> &gradient_x,
    const std::vector<double> &gradient_y,
    const std::vector<double> &gradient_z,
    double weight)
{
    const size_t n = gradient_x.size();
    check(gradient_y.size() == n && gradient_z.size() == n,
          "exchange-mass input component sizes must match");
    DeviceBuffer<double> d_x(n);
    DeviceBuffer<double> d_y(n);
    DeviceBuffer<double> d_z(n);
    DeviceBuffer<double> d_out_x(n);
    DeviceBuffer<double> d_out_y(n);
    DeviceBuffer<double> d_out_z(n);
    d_x.copy_from(gradient_x);
    d_y.copy_from(gradient_y);
    d_z.copy_from(gradient_z);

    std::string error;
    check(preconditioner.apply_device_xyz(
              d_x.get(), d_y.get(), d_z.get(),
              d_out_x.get(), d_out_y.get(), d_out_z.get(),
              n, weight, nullptr, error),
          "exchange-mass device apply must enqueue successfully");
    check(cudaDeviceSynchronize() == cudaSuccess,
          "exchange-mass test apply must synchronize outside the hot apply");
    check(d_x.copy_to_host() == gradient_x &&
              d_y.copy_to_host() == gradient_y &&
              d_z.copy_to_host() == gradient_z,
          "exchange-mass apply must not modify its gradient inputs");

    ExchangeMassResult result;
    result.x = d_out_x.copy_to_host();
    result.y = d_out_y.copy_to_host();
    result.z = d_out_z.copy_to_host();
    check(cudaMemcpy(
              result.residual_squared.data(),
              preconditioner.device_final_residual_squared(),
              result.residual_squared.size() * sizeof(double),
              cudaMemcpyDeviceToHost) == cudaSuccess,
          "exchange-mass residual diagnostics readback must succeed");
    check(cudaMemcpy(
              &result.iterations,
              preconditioner.device_iteration_count(),
              sizeof(result.iterations),
              cudaMemcpyDeviceToHost) == cudaSuccess,
          "exchange-mass iteration diagnostics readback must succeed");
    check(cudaMemcpy(
              &result.failure_latch,
              preconditioner.device_failure_latch(),
              sizeof(result.failure_latch),
              cudaMemcpyDeviceToHost) == cudaSuccess,
          "exchange-mass failure diagnostics readback must succeed");
    return result;
}

void check_sparse_exchange_mass_fixed_cg_contract()
{
    using namespace fullmag::fem;

    constexpr size_t n = 12;
    const DenseMatrix exchange = chain_exchange(n);
    const std::vector<double> mass = {
        0.8, 1.7, 0.6, 2.1, 1.2, 0.9, 1.9, 0.7, 1.4, 2.3, 1.0, 1.6};
    const std::vector<uint8_t> free_mask(n, 1u);
    const std::vector<double> gradient_x = {
        -1.0, 0.25, 1.5, -0.75, 2.0, 0.1, -1.3, 0.8, 1.1, -0.2, 0.6, -1.7};
    const std::vector<double> gradient_y = {
        0.3, -1.2, 0.4, 1.8, -0.6, 0.9, -1.5, 0.2, 1.4, -0.8, 0.7, 1.0};
    const std::vector<double> gradient_z = {
        1.1, 0.5, -0.9, 0.2, -1.8, 1.3, 0.6, -0.4, 0.75, -1.1, 1.9, -0.25};
    const double weight = 5.0;
    const DenseMatrix op = exchange_mass_operator(mass, exchange, weight);
    const auto rhs_x = mass_rhs(mass, gradient_x);
    const auto rhs_y = mass_rhs(mass, gradient_y);
    const auto rhs_z = mass_rhs(mass, gradient_z);
    const auto oracle_x = solve_dense(op, rhs_x);
    const auto oracle_y = solve_dense(op, rhs_y);
    const auto oracle_z = solve_dense(op, rhs_z);

    DeviceSparseOperator device_exchange(exchange);
    DeviceBuffer<double> d_mass(n);
    DeviceBuffer<uint8_t> d_mask(n);
    d_mass.copy_from(mass);
    d_mask.copy_from(free_mask);
    std::string error;
    const GpuExchangeMassSetupIdentity identity{101u, 203u, 307u};

    GpuExchangeMassPreconditioner cg4(GpuExchangeMassCgVariant::Cg4);
    GpuExchangeMassPreconditioner cg8(GpuExchangeMassCgVariant::Cg8);
    check(cg4.setup(
              device_exchange.plan, d_mass.get(), d_mask.get(), n,
              identity, nullptr, error),
          "CG4 exchange-mass setup must succeed");
    check(cg8.setup(
              device_exchange.plan, d_mass.get(), d_mask.get(), n,
              identity, nullptr, error),
          "CG8 exchange-mass setup must succeed");
    check(cg4.borrowed_sparse_plan() == &device_exchange.plan &&
              cg8.borrowed_sparse_plan() == &device_exchange.plan,
          "fixed CG must borrow one existing sparse plan without copying CSR");
    check(cg4.fixed_iterations() == 4u && cg8.fixed_iterations() == 8u,
          "CG variants must expose exact fixed iteration counts");

    const ExchangeMassResult result4 =
        apply_exchange_mass(cg4, gradient_x, gradient_y, gradient_z, weight);
    const ExchangeMassResult result8 =
        apply_exchange_mass(cg8, gradient_x, gradient_y, gradient_z, weight);
    check(result4.failure_latch == 0u && result8.failure_latch == 0u,
          "valid fixed CG solves must leave the failure latch clear");
    check(result4.iterations == 4u && result8.iterations == 8u,
          "device diagnostics must prove exact iterations without early host stop");
    check(device_exchange.plan.apply_count() == 12u,
          "borrowed sparse plan must execute once per fixed CG iteration");

    for (const auto &[actual4, actual8, oracle, rhs] :
         std::array<std::tuple<const std::vector<double> *,
                               const std::vector<double> *,
                               const std::vector<double> *,
                               const std::vector<double> *>, 3>{
             std::tuple{&result4.x, &result8.x, &oracle_x, &rhs_x},
             std::tuple{&result4.y, &result8.y, &oracle_y, &rhs_y},
             std::tuple{&result4.z, &result8.z, &oracle_z, &rhs_z}}) {
        const double residual4 = relative_residual(op, *actual4, *rhs);
        const double residual8 = relative_residual(op, *actual8, *rhs);
        check(residual4 < 2.5e-1,
              "CG4 residual must meet its explicit bounded-iteration threshold");
        check(residual8 < 2.0e-2,
              "CG8 residual must meet its tighter explicit bounded-iteration threshold");
        check(residual8 < residual4,
              "CG8 must improve the residual for the incomplete Krylov fixture");
        check(l2_error(*actual8, *oracle) < l2_error(*actual4, *oracle),
              "CG8 must move closer to the independent dense oracle than CG4");
    }
    const std::array<const std::vector<double> *, 3> actual4{
        &result4.x, &result4.y, &result4.z};
    const std::array<const std::vector<double> *, 3> actual8{
        &result8.x, &result8.y, &result8.z};
    const std::array<const std::vector<double> *, 3> rhs{
        &rhs_x, &rhs_y, &rhs_z};
    for (size_t component = 0; component < 3u; ++component) {
        const double expected4 = residual_squared(op, *actual4[component], *rhs[component]);
        const double expected8 = residual_squared(op, *actual8[component], *rhs[component]);
        check(std::abs(result4.residual_squared[component] - expected4) <=
                  1.0e-10 * std::max(1.0, expected4),
              "copied CG4 final residual diagnostic must match the host residual");
        check(std::abs(result8.residual_squared[component] - expected8) <=
                  1.0e-10 * std::max(1.0, expected8),
              "copied CG8 final residual diagnostic must match the host residual");
    }
    check(l2_error(result4.x, result8.x) > 1.0e-8,
          "CG4 and CG8 must produce distinct results before Krylov closure");

    std::vector<double> exchange_diagonal(n, 0.0);
    for (size_t i = 0; i < n; ++i) {
        exchange_diagonal[i] = exchange[i][i];
    }
    const auto diagonal_x =
        diagonal_solution(mass, exchange_diagonal, weight, gradient_x);
    check(l2_error(diagonal_x, oracle_x) > 1.0e-2,
          "diagonal multiplication must remain detectably wrong for the full sparse oracle");

    const double *const first_workspace = cg4.device_workspace_for_diagnostics();
    check(cg4.setup(
              device_exchange.plan, d_mass.get(), d_mask.get(), n,
              identity, nullptr, error),
          "identical fixed-CG setup must be reusable");
    check(cg4.setup_count() == 1u && cg4.setup_reuse_count() == 1u,
          "identical fixed-CG setup must be a cache hit");
    const GpuExchangeMassSetupIdentity changed_identity{102u, 203u, 307u};
    check(cg4.setup(
              device_exchange.plan, d_mass.get(), d_mask.get(), n,
              changed_identity, nullptr, error),
          "changed operator identity must invalidate fixed-CG setup");
    check(cg4.setup_count() == 2u,
          "changed identity must count a fresh logical setup");
    check(cg4.device_workspace_for_diagnostics() == first_workspace,
          "same-size identity invalidation must reuse persistent allocation");

    const uint64_t first_plan_generation =
        device_exchange.plan.configuration_generation();
    DeviceSparseOperator replacement_exchange(exchange);
    check(replacement_exchange.plan.configuration_generation() != first_plan_generation,
          "independent sparse plan setup must have a distinct generation");
    device_exchange.plan = std::move(replacement_exchange.plan);
    const uint64_t setup_count_before_plan_reconfigure = cg4.setup_count();
    check(cg4.setup(
              device_exchange.plan, d_mass.get(), d_mask.get(), n,
              changed_identity, nullptr, error),
          "same-address sparse plan reconfiguration must be accepted by fresh setup");
    check(cg4.setup_count() == setup_count_before_plan_reconfigure + 1u,
          "sparse plan generation change must invalidate exchange-mass setup reuse");

    const std::vector<double> zero(n, 0.0);
    const ExchangeMassResult zero_result =
        apply_exchange_mass(cg4, zero, zero, zero, weight);
    check(zero_result.failure_latch == 0u && zero_result.iterations == 4u,
          "active zero RHS must execute the exact safe fixed schedule");
    check_vector_close(zero_result.x, zero,
                       "active zero RHS x output must remain exactly zero");
    check_vector_close(zero_result.y, zero,
                       "active zero RHS y output must remain exactly zero");
    check_vector_close(zero_result.z, zero,
                       "active zero RHS z output must remain exactly zero");

    check(!cg4.apply_device_xyz(
              nullptr, nullptr, nullptr, nullptr, nullptr, nullptr,
              n, weight, nullptr, error),
          "null fixed-CG apply buffers must fail before launch");
    check(!cg4.apply_device_xyz(
              d_mass.get(), d_mass.get(), d_mass.get(),
              d_mass.get(), d_mass.get(), d_mass.get(),
              n - 1u, weight, nullptr, error),
          "fixed-CG apply dimension mismatch must fail before launch");
    check(!cg4.apply_device_xyz(
              d_mass.get(), d_mass.get(), d_mass.get(),
              d_mass.get(), d_mass.get(), d_mass.get(),
              n, std::numeric_limits<double>::infinity(), nullptr, error),
          "non-finite fixed-CG weight must fail before launch");
}

void check_sparse_exchange_mass_mask_and_failure_contract()
{
    using namespace fullmag::fem;

    const DenseMatrix exchange = chain_exchange(3u);
#if FULLMAG_HAS_CUSPARSE
    DeviceSparseOperator device_exchange(exchange, SparseApplyVariant::CusparseSpmv);
    check(device_exchange.plan.selected_variant() == SparseApplyVariant::CusparseSpmv,
          "CUDA cuSPARSE build must force CusparseSpmv for the odd-N core regression");
#else
    DeviceSparseOperator device_exchange(exchange);
#endif
    const std::vector<double> inactive_mass = {
        -1.0, std::numeric_limits<double>::quiet_NaN(), 0.0};
    const std::vector<uint8_t> inactive_mask = {0u, 0u, 0u};
    DeviceBuffer<double> d_mass(3u);
    DeviceBuffer<uint8_t> d_mask(3u);
    d_mass.copy_from(inactive_mass);
    d_mask.copy_from(inactive_mask);
    GpuExchangeMassPreconditioner cg4(GpuExchangeMassCgVariant::Cg4);
    std::string error;
    check(cg4.setup(
              device_exchange.plan, d_mass.get(), d_mask.get(), 3u,
              {1u, 2u, 3u}, nullptr, error),
          "inactive and fixed nodes must not require positive finite mass");
    check(cg4.device_workspace_component_stride() == 4u &&
              cg4.device_workspace_value_count() == 60u,
          "odd-N fixed-CG workspace must expose 15 padded, aligned blocks");
    const std::vector<double> nonzero = {1.0, -2.0, 3.0};
    const ExchangeMassResult zero_result =
        apply_exchange_mass(cg4, nonzero, nonzero, nonzero, 0.75);
    check(zero_result.iterations == 4u && zero_result.failure_latch == 0u,
          "all-masked solve must still execute exactly four safe iterations");
    check_vector_close(zero_result.x, {0.0, 0.0, 0.0},
                       "inactive x output must be exactly zero");
    check_vector_close(zero_result.y, {0.0, 0.0, 0.0},
                       "inactive y output must be exactly zero");
    check_vector_close(zero_result.z, {0.0, 0.0, 0.0},
                       "inactive z output must be exactly zero");
    std::vector<double> workspace(cg4.device_workspace_value_count());
    check(cudaMemcpy(
              workspace.data(), cg4.device_workspace_for_diagnostics(),
              workspace.size() * sizeof(double), cudaMemcpyDeviceToHost) == cudaSuccess,
          "masked fixed-CG workspace readback must succeed");
    check(std::all_of(workspace.begin(), workspace.end(),
                      [](double value) { return value == 0.0; }),
          "inactive and fixed workspace entries must remain exactly zero");

    SparseApplyPlan unconfigured_plan;
    GpuExchangeMassPreconditioner invalid(GpuExchangeMassCgVariant::Cg4);
    check(!invalid.setup(
              unconfigured_plan, d_mass.get(), d_mask.get(), 3u,
              {1u, 2u, 3u}, nullptr, error),
          "fixed-CG setup must reject a missing CSR plan");
    check(!invalid.setup(
              device_exchange.plan, nullptr, d_mask.get(), 3u,
              {1u, 2u, 3u}, nullptr, error),
          "fixed-CG setup must reject a missing mass vector");
    check(!invalid.setup(
              device_exchange.plan, d_mass.get(), d_mask.get(), 2u,
              {1u, 2u, 3u}, nullptr, error),
          "fixed-CG setup must reject a dimension inconsistent with CSR");

    const std::vector<double> invalid_active_mass = {1.0, 0.0, 2.0};
    const std::vector<uint8_t> active_mask = {1u, 1u, 1u};
    d_mass.copy_from(invalid_active_mass);
    d_mask.copy_from(active_mask);
    check(!invalid.setup(
              device_exchange.plan, d_mass.get(), d_mask.get(), 3u,
              {4u, 5u, 6u}, nullptr, error),
          "fixed-CG setup must reject non-positive active mass");

    const std::vector<double> valid_mass = {2.0, 2.0, 2.0};
    d_mass.copy_from(valid_mass);
    GpuExchangeMassPreconditioner latched(GpuExchangeMassCgVariant::Cg4);
    check(latched.setup(
              device_exchange.plan, d_mass.get(), d_mask.get(), 3u,
              {7u, 8u, 9u}, nullptr, error),
          "failure-latch fixture setup must succeed");

    DeviceBuffer<double> d_gradient_x(3u);
    DeviceBuffer<double> d_gradient_y(3u);
    DeviceBuffer<double> d_gradient_z(3u);
    DeviceBuffer<double> d_solution_x(3u);
    DeviceBuffer<double> d_solution_y(3u);
    DeviceBuffer<double> d_solution_z(3u);
    d_gradient_x.copy_from(nonzero);
    d_gradient_y.copy_from(nonzero);
    d_gradient_z.copy_from(nonzero);
    const std::array<const double *, 3> gradients{
        d_gradient_x.get(), d_gradient_y.get(), d_gradient_z.get()};
    const std::array<double *, 3> independent_solutions{
        d_solution_x.get(), d_solution_y.get(), d_solution_z.get()};
    for (size_t input = 0; input < gradients.size(); ++input) {
        for (size_t output = 0; output < independent_solutions.size(); ++output) {
            auto solutions = independent_solutions;
            solutions[output] = const_cast<double *>(gradients[input]);
            (void)cudaGetLastError();
            check(!latched.apply_device_xyz(
                      gradients[0], gradients[1], gradients[2],
                      solutions[0], solutions[1], solutions[2],
                      3u, 0.75, nullptr, error),
                  "every gradient/solution cross-alias must fail before launch");
            check(error.find("alias") != std::string::npos,
                  "gradient/solution alias rejection must be explicit");
            check(cudaPeekAtLastError() == cudaSuccess,
                  "gradient/solution alias rejection must not enqueue CUDA work");
        }
    }

    const ExchangeMassResult zero_weight =
        apply_exchange_mass(latched, nonzero, nonzero, nonzero, 0.0);
    check(zero_weight.failure_latch == 0u,
          "zero exchange weight must remain a valid mass-only solve");
    check_vector_close(zero_weight.x, nonzero,
                       "zero exchange weight x must solve Mz=Mg");
    check_vector_close(zero_weight.y, nonzero,
                       "zero exchange weight y must solve Mz=Mg");
    check_vector_close(zero_weight.z, nonzero,
                       "zero exchange weight z must solve Mz=Mg");
    check(std::all_of(
              zero_weight.residual_squared.begin(),
              zero_weight.residual_squared.end(),
              [](double value) { return value <= 1.0e-24; }),
          "zero exchange weight final residual diagnostics must be zero");

    const std::vector<uint8_t> mixed_mask = {1u, 0u, 1u};
    d_mask.copy_from(mixed_mask);
    GpuExchangeMassPreconditioner mixed(GpuExchangeMassCgVariant::Cg4);
    check(mixed.setup(
              device_exchange.plan, d_mass.get(), d_mask.get(), 3u,
              {10u, 11u, 12u}, nullptr, error),
          "mixed active/fixed fixture setup must succeed");
    const ExchangeMassResult mixed_result =
        apply_exchange_mass(mixed, nonzero, nonzero, nonzero, 0.75);
    check(mixed_result.failure_latch == 0u,
          "mixed active/fixed solve must remain valid");
    check(mixed_result.x[1] == 0.0 && mixed_result.y[1] == 0.0 &&
              mixed_result.z[1] == 0.0,
          "mixed fixed-node outputs must remain exactly zero");
    const std::vector<double> mixed_workspace = [&]() {
        std::vector<double> host(mixed.device_workspace_value_count());
        check(cudaMemcpy(
                  host.data(), mixed.device_workspace_for_diagnostics(),
                  host.size() * sizeof(double), cudaMemcpyDeviceToHost) == cudaSuccess,
              "mixed fixed-CG workspace readback must succeed");
        return host;
    }();
    for (size_t block = 0; block < 15u; ++block) {
        check(mixed_workspace[block * mixed.device_workspace_component_stride() + 1u] == 0.0,
              "mixed fixed-node workspace entries must remain exactly zero");
    }

    d_mask.copy_from(active_mask);
    check(latched.setup(
              device_exchange.plan, d_mass.get(), d_mask.get(), 3u,
              {13u, 14u, 15u}, nullptr, error),
          "active failure-latch fixture re-setup must succeed");
    const std::vector<double> invalid_rhs = {
        1.0, std::numeric_limits<double>::infinity(), -1.0};
    ExchangeMassResult failed =
        apply_exchange_mass(latched, invalid_rhs, nonzero, nonzero, 0.75);
    check(failed.failure_latch != 0u,
          "non-finite device input must set the failure latch");
    check_vector_close(failed.x, {0.0, 0.0, 0.0},
                       "failed fixed-CG solve must zero partial output");
    failed = apply_exchange_mass(latched, nonzero, nonzero, nonzero, 0.75);
    check(failed.failure_latch != 0u,
          "device failure latch must remain monotonic for one setup identity");
    check_vector_close(failed.x, {0.0, 0.0, 0.0},
                       "latched fixed-CG solve must remain fail-closed");

    const DenseMatrix indefinite_exchange = {
        {-2.0, 0.0},
        {0.0, -2.0},
    };
    DeviceSparseOperator indefinite_device(indefinite_exchange);
    DeviceBuffer<double> d_breakdown_mass(2u);
    DeviceBuffer<uint8_t> d_breakdown_mask(2u);
    d_breakdown_mass.copy_from({1.0, 1.0});
    d_breakdown_mask.copy_from({1u, 1u});
    GpuExchangeMassPreconditioner breakdown(GpuExchangeMassCgVariant::Cg4);
    check(breakdown.setup(
              indefinite_device.plan, d_breakdown_mass.get(), d_breakdown_mask.get(), 2u,
              {10u, 11u, 12u}, nullptr, error),
          "breakdown fixture setup must succeed before device recurrence");
    const ExchangeMassResult breakdown_result =
        apply_exchange_mass(breakdown, {1.0, -1.0}, {0.5, 2.0}, {-0.5, 1.0}, 1.0);
    check(breakdown_result.iterations == 4u,
          "breakdown path must preserve the fixed launch schedule");
    check(breakdown_result.failure_latch != 0u,
          "non-positive CG denominator must set the failure latch");
    check_vector_close(breakdown_result.x, {0.0, 0.0},
                       "breakdown must zero partial fixed-CG output");
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

void check_pgbb_raw_gradient_fallback_contract()
{
    using namespace fullmag::fem;
    constexpr size_t n = 16;
    DeviceBuffer<double> raw_gx(n);
    DeviceBuffer<double> raw_gy(n);
    DeviceBuffer<double> raw_gz(n);
    DeviceBuffer<double> z_x(n);
    DeviceBuffer<double> z_y(n);
    DeviceBuffer<double> z_z(n);

    std::vector<double> host_gx(n), host_gy(n), host_gz(n);
    std::vector<double> host_zx(n), host_zy(n), host_zz(n);
    for (size_t i = 0; i < n; ++i) {
        host_gx[i] = 1.0 + static_cast<double>(i) * 0.5;
        host_gy[i] = 2.0 + static_cast<double>(i) * 0.5;
        host_gz[i] = 3.0 + static_cast<double>(i) * 0.5;
        // Non-descent preconditioned values
        host_zx[i] = -10.0 - static_cast<double>(i);
        host_zy[i] = -20.0 - static_cast<double>(i);
        host_zz[i] = -30.0 - static_cast<double>(i);
    }

    raw_gx.copy_from(host_gx);
    raw_gy.copy_from(host_gy);
    raw_gz.copy_from(host_gz);
    z_x.copy_from(host_zx);
    z_y.copy_from(host_zy);
    z_z.copy_from(host_zz);

    FemGpuComponentField raw_g{};
    raw_g.x = raw_gx.get();
    raw_g.y = raw_gy.get();
    raw_g.z = raw_gz.get();

    FemGpuComponentField precond_z{};
    precond_z.x = z_x.get();
    precond_z.y = z_y.get();
    precond_z.z = z_z.get();

    std::string reason;
    // The exact call from PG-BB fallback: copy raw gradient g into preconditioned z
    const bool copy_ok = gpu_rk_copy_component_device(
        raw_g,
        precond_z,
        n,
        nullptr,
        "cudaMemcpyAsync GPU projected-gradient BB raw-gradient descent fallback",
        reason);
    check(copy_ok, "gpu_rk_copy_component_device fallback copy must succeed");
    check(cudaDeviceSynchronize() == cudaSuccess, "fallback copy synchronize must succeed");

    std::vector<double> read_raw_gx = raw_gx.copy_to_host();
    std::vector<double> read_raw_gy = raw_gy.copy_to_host();
    std::vector<double> read_raw_gz = raw_gz.copy_to_host();
    std::vector<double> read_zx = z_x.copy_to_host();
    std::vector<double> read_zy = z_y.copy_to_host();
    std::vector<double> read_zz = z_z.copy_to_host();

    // 1. Raw gradient g must remain completely unchanged
    check_vector_close(read_raw_gx, host_gx, "fallback must not modify raw gradient g.x");
    check_vector_close(read_raw_gy, host_gy, "fallback must not modify raw gradient g.y");
    check_vector_close(read_raw_gz, host_gz, "fallback must not modify raw gradient g.z");

    // 2. Preconditioned gradient z must now match raw gradient g
    check_vector_close(read_zx, host_gx, "fallback must copy raw gradient g.x into preconditioned z.x");
    check_vector_close(read_zy, host_gy, "fallback must copy raw gradient g.y into preconditioned z.y");
    check_vector_close(read_zz, host_gz, "fallback must copy raw gradient g.z into preconditioned z.z");
}

void check_ncg_preconditioned_pr_plus_parity_contract()
{
    using namespace fullmag::fem;
    constexpr size_t n = 16;
    constexpr double mu0 = 1.25663706212e-6;

    std::vector<double> host_mx(n), host_my(n), host_mz(n);
    std::vector<double> host_prev_gx(n), host_prev_gy(n), host_prev_gz(n);
    std::vector<double> host_prev_zx(n), host_prev_zy(n), host_prev_zz(n);
    std::vector<double> host_trial_gx(n), host_trial_gy(n), host_trial_gz(n);
    std::vector<double> host_trial_zx(n), host_trial_zy(n), host_trial_zz(n);
    std::vector<double> host_prev_px(n), host_prev_py(n), host_prev_pz(n);
    std::vector<double> host_ms(n, 8.0e5);
    std::vector<double> host_mass(n, 1.0e-24);
    std::vector<uint8_t> host_mask(n, 1);

    host_mask[0] = 0; // inactive node

    for (size_t i = 0; i < n; ++i) {
        const double angle = 0.2 * static_cast<double>(i);
        host_mx[i] = std::cos(angle) * 0.8;
        host_my[i] = std::sin(angle) * 0.8;
        host_mz[i] = std::sqrt(std::max(0.0, 1.0 - host_mx[i] * host_mx[i] - host_my[i] * host_my[i]));

        host_prev_gx[i] = 100.0 + 5.0 * static_cast<double>(i);
        host_prev_gy[i] = 50.0 - 2.0 * static_cast<double>(i);
        host_prev_gz[i] = 30.0 + 3.0 * static_cast<double>(i);

        host_prev_zx[i] = host_prev_gx[i] * 1.5;
        host_prev_zy[i] = host_prev_gy[i] * 0.8;
        host_prev_zz[i] = host_prev_gz[i] * 2.0;

        const double g_raw[3] = {-80.0 + 4.0 * static_cast<double>(i), 120.0 + static_cast<double>(i), -60.0 + 2.0 * static_cast<double>(i)};
        const double dot_m = g_raw[0] * host_mx[i] + g_raw[1] * host_my[i] + g_raw[2] * host_mz[i];
        host_trial_gx[i] = g_raw[0] - dot_m * host_mx[i];
        host_trial_gy[i] = g_raw[1] - dot_m * host_my[i];
        host_trial_gz[i] = g_raw[2] - dot_m * host_mz[i];

        const double z_raw[3] = {host_trial_gx[i] * 1.8, host_trial_gy[i] * 0.9, host_trial_gz[i] * 1.4};
        const double dot_mz = z_raw[0] * host_mx[i] + z_raw[1] * host_my[i] + z_raw[2] * host_mz[i];
        host_trial_zx[i] = z_raw[0] - dot_mz * host_mx[i];
        host_trial_zy[i] = z_raw[1] - dot_mz * host_my[i];
        host_trial_zz[i] = z_raw[2] - dot_mz * host_mz[i];

        host_prev_px[i] = -host_prev_zx[i] * 0.5;
        host_prev_py[i] = -host_prev_zy[i] * 0.5;
        host_prev_pz[i] = -host_prev_zz[i] * 0.5;
    }

    // CPU reference computation
    double cpu_num = 0.0;
    double cpu_den = 0.0;
    double cpu_abs_den = 0.0;
    double cpu_trial_z_dot_g = 0.0;
    for (size_t i = 0; i < n; ++i) {
        if (host_mask[i] == 0) continue;
        const double w = mu0 * host_ms[i] * host_mass[i];
        const double dot_m_z = host_mx[i] * host_prev_zx[i] +
                               host_my[i] * host_prev_zy[i] +
                               host_mz[i] * host_prev_zz[i];
        const double z_trans_x = host_prev_zx[i] - dot_m_z * host_mx[i];
        const double z_trans_y = host_prev_zy[i] - dot_m_z * host_my[i];
        const double z_trans_z = host_prev_zz[i] - dot_m_z * host_mz[i];

        const double yz_x = host_trial_zx[i] - z_trans_x;
        const double yz_y = host_trial_zy[i] - z_trans_y;
        const double yz_z = host_trial_zz[i] - z_trans_z;

        cpu_num += w * (host_trial_gx[i] * yz_x + host_trial_gy[i] * yz_y + host_trial_gz[i] * yz_z);
        cpu_den += w * (host_prev_gx[i] * host_prev_zx[i] + host_prev_gy[i] * host_prev_zy[i] + host_prev_gz[i] * host_prev_zz[i]);
        cpu_abs_den += w * (std::abs(host_prev_gx[i] * host_prev_zx[i]) +
                            std::abs(host_prev_gy[i] * host_prev_zy[i]) +
                            std::abs(host_prev_gz[i] * host_prev_zz[i]));
        cpu_trial_z_dot_g += w * (host_trial_zx[i] * host_trial_gx[i] +
                                  host_trial_zy[i] * host_trial_gy[i] +
                                  host_trial_zz[i] * host_trial_gz[i]);
    }

    const double roundoff = relaxation::reduction_roundoff_bound(3 * n);
    double cpu_beta = 0.0;
    if (cpu_den > roundoff * cpu_abs_den && std::isfinite(cpu_den) && std::isfinite(cpu_num)) {
        cpu_beta = std::max(0.0, cpu_num / cpu_den);
    }

    std::vector<double> cpu_next_px(n, 0.0), cpu_next_py(n, 0.0), cpu_next_pz(n, 0.0);
    double cpu_p_dot_g = 0.0;
    for (size_t i = 0; i < n; ++i) {
        if (host_mask[i] == 0) continue;
        const double dot_m_p = host_mx[i] * host_prev_px[i] +
                               host_my[i] * host_prev_py[i] +
                               host_mz[i] * host_prev_pz[i];
        const double p_trans_x = host_prev_px[i] - dot_m_p * host_mx[i];
        const double p_trans_y = host_prev_py[i] - dot_m_p * host_my[i];
        const double p_trans_z = host_prev_pz[i] - dot_m_p * host_mz[i];

        const double px = -host_trial_zx[i] + cpu_beta * p_trans_x;
        const double py = -host_trial_zy[i] + cpu_beta * p_trans_y;
        const double pz = -host_trial_zz[i] + cpu_beta * p_trans_z;
        cpu_next_px[i] = px;
        cpu_next_py[i] = py;
        cpu_next_pz[i] = pz;

        const double w = mu0 * host_ms[i] * host_mass[i];
        cpu_p_dot_g += w * (px * host_trial_gx[i] + py * host_trial_gy[i] + pz * host_trial_gz[i]);
    }
    if (!std::isfinite(cpu_p_dot_g) || cpu_p_dot_g >= 0.0) {
        if (std::isfinite(cpu_trial_z_dot_g) && cpu_trial_z_dot_g > 0.0) {
            for (size_t i = 0; i < n; ++i) {
                if (host_mask[i] == 0) continue;
                cpu_next_px[i] = -host_trial_zx[i];
                cpu_next_py[i] = -host_trial_zy[i];
                cpu_next_pz[i] = -host_trial_zz[i];
            }
        } else {
            for (size_t i = 0; i < n; ++i) {
                if (host_mask[i] == 0) continue;
                cpu_next_px[i] = -host_trial_gx[i];
                cpu_next_py[i] = -host_trial_gy[i];
                cpu_next_pz[i] = -host_trial_gz[i];
            }
        }
    }

    DeviceBuffer<double> d_mx(n), d_my(n), d_mz(n);
    DeviceBuffer<double> d_prev_gx(n), d_prev_gy(n), d_prev_gz(n);
    DeviceBuffer<double> d_prev_zx(n), d_prev_zy(n), d_prev_zz(n);
    DeviceBuffer<double> d_trial_gx(n), d_trial_gy(n), d_trial_gz(n);
    DeviceBuffer<double> d_trial_zx(n), d_trial_zy(n), d_trial_zz(n);
    DeviceBuffer<double> d_prev_px(n), d_prev_py(n), d_prev_pz(n);
    DeviceBuffer<double> d_next_px(n), d_next_py(n), d_next_pz(n);
    DeviceBuffer<double> d_ms(n), d_mass(n);
    DeviceBuffer<uint8_t> d_mask(n);

    d_mx.copy_from(host_mx); d_my.copy_from(host_my); d_mz.copy_from(host_mz);
    d_prev_gx.copy_from(host_prev_gx); d_prev_gy.copy_from(host_prev_gy); d_prev_gz.copy_from(host_prev_gz);
    d_prev_zx.copy_from(host_prev_zx); d_prev_zy.copy_from(host_prev_zy); d_prev_zz.copy_from(host_prev_zz);
    d_trial_gx.copy_from(host_trial_gx); d_trial_gy.copy_from(host_trial_gy); d_trial_gz.copy_from(host_trial_gz);
    d_trial_zx.copy_from(host_trial_zx); d_trial_zy.copy_from(host_trial_zy); d_trial_zz.copy_from(host_trial_zz);
    d_prev_px.copy_from(host_prev_px); d_prev_py.copy_from(host_prev_py); d_prev_pz.copy_from(host_prev_pz);
    d_ms.copy_from(host_ms); d_mass.copy_from(host_mass); d_mask.copy_from(host_mask);

    const int blocks = (static_cast<int>(n) + 256 - 1) / 256;
    DeviceBuffer<double> block_num(blocks), block_den(blocks), block_abs_den(blocks), block_z_dot_g(blocks);
    DeviceBuffer<double> block_p_dot_g(blocks);
    DeviceBuffer<double> d_scalar_num(1), d_scalar_den(1), d_scalar_abs_den(1), d_scalar_z_dot_g(1);
    DeviceBuffer<double> d_scalar_p_dot_g(1);

    fullmag_cuda_relax_ncg_preconditioned_pr_plus_blocks(
        d_mx.get(), d_my.get(), d_mz.get(),
        d_prev_gx.get(), d_prev_gy.get(), d_prev_gz.get(),
        d_prev_zx.get(), d_prev_zy.get(), d_prev_zz.get(),
        d_trial_gx.get(), d_trial_gy.get(), d_trial_gz.get(),
        d_trial_zx.get(), d_trial_zy.get(), d_trial_zz.get(),
        d_ms.get(), d_mass.get(), d_mask.get(),
        block_num.get(), block_den.get(), block_abs_den.get(), block_z_dot_g.get(),
        static_cast<int>(n), nullptr);

    size_t temp_bytes = 0;
    check(fullmag_cuda_device_sum(block_num.get(), blocks, d_scalar_num.get(), nullptr, temp_bytes, nullptr) == cudaSuccess,
          "device sum query must succeed");
    DeviceBuffer<uint8_t> temp_storage(temp_bytes);
    check(fullmag_cuda_device_sum(block_num.get(), blocks, d_scalar_num.get(), temp_storage.get(), temp_bytes, nullptr) == cudaSuccess,
          "device sum block_num must succeed");
    check(fullmag_cuda_device_sum(block_den.get(), blocks, d_scalar_den.get(), temp_storage.get(), temp_bytes, nullptr) == cudaSuccess,
          "device sum block_den must succeed");
    check(fullmag_cuda_device_sum(block_abs_den.get(), blocks, d_scalar_abs_den.get(), temp_storage.get(), temp_bytes, nullptr) == cudaSuccess,
          "device sum block_abs_den must succeed");
    check(fullmag_cuda_device_sum(block_z_dot_g.get(), blocks, d_scalar_z_dot_g.get(), temp_storage.get(), temp_bytes, nullptr) == cudaSuccess,
          "device sum block_z_dot_g must succeed");

    fullmag_cuda_relax_ncg_update_direction_preconditioned_pr_plus(
        d_mx.get(), d_my.get(), d_mz.get(),
        d_trial_gx.get(), d_trial_gy.get(), d_trial_gz.get(),
        d_trial_zx.get(), d_trial_zy.get(), d_trial_zz.get(),
        d_prev_px.get(), d_prev_py.get(), d_prev_pz.get(),
        d_scalar_num.get(), d_scalar_den.get(), d_scalar_abs_den.get(),
        d_ms.get(), d_mass.get(), d_mask.get(),
        roundoff, true, false,
        d_next_px.get(), d_next_py.get(), d_next_pz.get(),
        block_p_dot_g.get(), static_cast<int>(n), nullptr);

    check(fullmag_cuda_device_sum(block_p_dot_g.get(), blocks, d_scalar_p_dot_g.get(), temp_storage.get(), temp_bytes, nullptr) == cudaSuccess,
          "device sum block_p_dot_g must succeed");

    fullmag_cuda_relax_ncg_preconditioned_descent_fallback(
        d_trial_gx.get(), d_trial_gy.get(), d_trial_gz.get(),
        d_trial_zx.get(), d_trial_zy.get(), d_trial_zz.get(),
        d_scalar_p_dot_g.get(), d_scalar_z_dot_g.get(), d_mask.get(),
        d_next_px.get(), d_next_py.get(), d_next_pz.get(),
        static_cast<int>(n), nullptr);

    check(cudaDeviceSynchronize() == cudaSuccess, "ncg kernels synchronize must succeed");

    std::vector<double> gpu_num = d_scalar_num.copy_to_host();
    std::vector<double> gpu_den = d_scalar_den.copy_to_host();
    std::vector<double> gpu_abs_den = d_scalar_abs_den.copy_to_host();
    std::vector<double> gpu_z_dot_g = d_scalar_z_dot_g.copy_to_host();
    std::vector<double> read_next_px = d_next_px.copy_to_host();
    std::vector<double> read_next_py = d_next_py.copy_to_host();
    std::vector<double> read_next_pz = d_next_pz.copy_to_host();

    check(close(gpu_num[0], cpu_num, 1.0e-12), "preconditioned PR+ numerator must match CPU reference");
    check(close(gpu_den[0], cpu_den, 1.0e-12), "preconditioned PR+ denominator must match CPU reference");
    check(close(gpu_abs_den[0], cpu_abs_den, 1.0e-12), "preconditioned PR+ abs denominator must match CPU reference");
    check(close(gpu_z_dot_g[0], cpu_trial_z_dot_g, 1.0e-12), "preconditioned z_dot_g must match CPU reference");

    check_vector_close(read_next_px, cpu_next_px, "preconditioned PR+ next_px must match CPU reference");
    check_vector_close(read_next_py, cpu_next_py, "preconditioned PR+ next_py must match CPU reference");
    check_vector_close(read_next_pz, cpu_next_pz, "preconditioned PR+ next_pz must match CPU reference");

    // Tier 2 Fallback Test: Force candidate p_dot_g >= 0 with positive z_dot_g
    {
        double bad_p_dot_g = 100.0;
        double good_z_dot_g = 50.0;
        d_scalar_p_dot_g.copy_from({bad_p_dot_g});
        d_scalar_z_dot_g.copy_from({good_z_dot_g});
        fullmag_cuda_relax_ncg_preconditioned_descent_fallback(
            d_trial_gx.get(), d_trial_gy.get(), d_trial_gz.get(),
            d_trial_zx.get(), d_trial_zy.get(), d_trial_zz.get(),
            d_scalar_p_dot_g.get(), d_scalar_z_dot_g.get(), d_mask.get(),
            d_next_px.get(), d_next_py.get(), d_next_pz.get(),
            static_cast<int>(n), nullptr);
        check(cudaDeviceSynchronize() == cudaSuccess, "fallback Tier 2 synchronize must succeed");
        read_next_px = d_next_px.copy_to_host();
        for (size_t i = 1; i < n; ++i) {
            check(close(read_next_px[i], -host_trial_zx[i], 1.0e-12), "fallback Tier 2 must select -z");
        }
    }

    // Tier 3 Fallback Test: Force candidate p_dot_g >= 0 and z_dot_g <= 0 (non-descent -z)
    {
        double bad_p_dot_g = 100.0;
        double bad_z_dot_g = -50.0;
        d_scalar_p_dot_g.copy_from({bad_p_dot_g});
        d_scalar_z_dot_g.copy_from({bad_z_dot_g});
        fullmag_cuda_relax_ncg_preconditioned_descent_fallback(
            d_trial_gx.get(), d_trial_gy.get(), d_trial_gz.get(),
            d_trial_zx.get(), d_trial_zy.get(), d_trial_zz.get(),
            d_scalar_p_dot_g.get(), d_scalar_z_dot_g.get(), d_mask.get(),
            d_next_px.get(), d_next_py.get(), d_next_pz.get(),
            static_cast<int>(n), nullptr);
        check(cudaDeviceSynchronize() == cudaSuccess, "fallback Tier 3 synchronize must succeed");
        read_next_px = d_next_px.copy_to_host();
        for (size_t i = 1; i < n; ++i) {
            check(close(read_next_px[i], -host_trial_gx[i], 1.0e-12), "fallback Tier 3 must select -g");
        }
    }
}

void check_direct_minimizer_all_preconditioner_profiles_and_latch_recovery_contract()
{
    using namespace fullmag::fem;

    constexpr size_t n = 12;
    const DenseMatrix exchange = chain_exchange(n);
    const std::vector<double> mass = {
        0.8, 1.7, 0.6, 2.1, 1.2, 0.9, 1.9, 0.7, 1.4, 2.3, 1.0, 1.6};
    const std::vector<uint8_t> free_mask(n, 1u);
    DeviceSparseOperator device_exchange(exchange);
    DeviceBuffer<double> d_mass(n);
    DeviceBuffer<uint8_t> d_mask(n);
    d_mass.copy_from(mass);
    d_mask.copy_from(free_mask);
    const double weight = 0.35;
    std::string error;
    const GpuExchangeMassSetupIdentity identity{401u, 502u, 603u};

    const std::vector<double> gradient_x = {
        0.5, -0.4, 0.3, -0.2, 0.1, -0.6, 0.7, -0.8, 0.9, -0.3, 0.4, -0.5};
    const std::vector<double> gradient_y = {
        -0.2, 0.8, -0.1, 0.4, -0.5, 0.3, -0.7, 0.6, -0.2, 0.5, -0.4, 0.1};
    const std::vector<double> gradient_z = {
        0.3, 0.1, -0.5, 0.6, -0.2, 0.4, -0.1, 0.3, -0.6, 0.2, -0.5, 0.7};

    // 1. Profile 'none': z = g exactly
    std::vector<double> z_none_x = gradient_x;
    check_vector_close(z_none_x, gradient_x, "none profile must preserve raw gradient");

    // 2. Profile 'diagonal': z = g / (M + w*diag(K))
    GpuDiagonalRelaxationPreconditioner diag_precond;
    std::vector<double> exchange_diagonal(n, 0.0);
    for (size_t i = 0; i < n; ++i) {
        exchange_diagonal[i] = exchange[i][i];
    }
    check(diag_precond.setup(mass, exchange_diagonal, weight, nullptr, error),
          "diagonal preconditioner setup must succeed");
    std::vector<double> z_diag_x;
    check(diag_precond.apply_host(gradient_x, z_diag_x, error),
          "diagonal host apply must succeed");
    check(l2_error(z_diag_x, gradient_x) > 1.0e-3,
          "diagonal preconditioner must differ from raw gradient");

    // 3. Profile 'exchange_mass_cg4'
    GpuExchangeMassPreconditioner cg4(GpuExchangeMassCgVariant::Cg4);
    check(cg4.setup(device_exchange.plan, d_mass.get(), d_mask.get(), n, identity, nullptr, error),
          "cg4 setup must succeed");
    const ExchangeMassResult result_cg4 =
        apply_exchange_mass(cg4, gradient_x, gradient_y, gradient_z, weight);
    check(result_cg4.failure_latch == 0u, "cg4 latch must be clear");
    check(result_cg4.iterations == 4u, "cg4 must execute 4 iterations");
    check(l2_error(result_cg4.x, gradient_x) > 1.0e-3,
          "cg4 must differ from raw gradient");
    check(l2_error(result_cg4.x, z_diag_x) > 1.0e-3,
          "cg4 must differ from diagonal preconditioner");

    // 4. Profile 'exchange_mass_cg8'
    GpuExchangeMassPreconditioner cg8(GpuExchangeMassCgVariant::Cg8);
    check(cg8.setup(device_exchange.plan, d_mass.get(), d_mask.get(), n, identity, nullptr, error),
          "cg8 setup must succeed");
    const ExchangeMassResult result_cg8 =
        apply_exchange_mass(cg8, gradient_x, gradient_y, gradient_z, weight);
    check(result_cg8.failure_latch == 0u, "cg8 latch must be clear");
    check(result_cg8.iterations == 8u, "cg8 must execute 8 iterations");
    check(l2_error(result_cg8.x, result_cg4.x) > 1.0e-4,
          "cg8 must produce distinct refined output compared to cg4");
    check(l2_error(result_cg8.x, z_diag_x) > 1.0e-3,
          "cg8 must differ from diagonal preconditioner");

    // 5. Preconditioner failure latch and recovery contract:
    // Artificially corrupt the failure latch on device to simulate breakdown
    const uint32_t simulated_failure = 1u;
    check(cudaMemcpy(
              const_cast<uint32_t *>(cg4.device_failure_latch()),
              &simulated_failure,
              sizeof(simulated_failure),
              cudaMemcpyHostToDevice) == cudaSuccess,
          "simulating failure latch on device must succeed");

    // Verify latch is non-zero
    uint32_t readback_latch = 0u;
    check(cudaMemcpy(
              &readback_latch,
              cg4.device_failure_latch(),
              sizeof(readback_latch),
              cudaMemcpyDeviceToHost) == cudaSuccess,
          "readback of simulated failure latch must succeed");
    check(readback_latch == 1u, "simulated latch must be 1");

    // Subsequent apply under the same setup identity must remain failed (monotonicity)
    const ExchangeMassResult still_failed =
        apply_exchange_mass(cg4, gradient_x, gradient_y, gradient_z, weight);
    check(still_failed.failure_latch != 0u,
          "device failure latch must remain monotonic across applies for one setup identity");

    // Re-setup resets device failure latch and enables clean recovery
    check(cg4.setup(
              device_exchange.plan, d_mass.get(), d_mask.get(), n,
              {100u, 101u, 102u}, nullptr, error),
          "re-setup after simulated failure latch must succeed");
    const ExchangeMassResult recovered_result =
        apply_exchange_mass(cg4, gradient_x, gradient_y, gradient_z, weight);
    check(recovered_result.failure_latch == 0u,
          "subsequent attempt after re-setup must recover with clean failure latch == 0");
    check(recovered_result.iterations == 4u,
          "recovered attempt must execute full schedule");
    check_vector_close(recovered_result.x, result_cg4.x,
                       "recovered attempt must produce identical valid results");
}

void check_cub_reduction_status_propagation_contract()
{
    const int count = 10000;
    std::vector<double> host_values(count, 0.0);
    double expected_sum = 0.0;
    for (int i = 0; i < count; ++i) {
        host_values[i] = std::sin(static_cast<double>(i));
        expected_sum += host_values[i];
    }
    // Place known extremal sentinels
    host_values[42] = 84.5;
    host_values[1337] = -123.4;
    expected_sum += (84.5 - std::sin(42.0)) + (-123.4 - std::sin(1337.0));

    DeviceBuffer<double> d_input(count);
    d_input.copy_from(host_values);
    DeviceBuffer<double> d_result(1);

    size_t temp_bytes_max = 0;
    const cudaError_t max_query_rc = fullmag::fem::fullmag_cuda_device_max(
        d_input.get(), count, d_result.get(), nullptr, temp_bytes_max, nullptr);
    check(max_query_rc == cudaSuccess,
          "fullmag_cuda_device_max query mode must return cudaSuccess");
    check(temp_bytes_max > 0, "max query temp_storage_bytes must be > 0");

    size_t temp_bytes_min = 0;
    const cudaError_t min_query_rc = fullmag::fem::fullmag_cuda_device_min(
        d_input.get(), count, d_result.get(), nullptr, temp_bytes_min, nullptr);
    check(min_query_rc == cudaSuccess,
          "fullmag_cuda_device_min query mode must return cudaSuccess");
    check(temp_bytes_min > 0, "min query temp_storage_bytes must be > 0");

    size_t temp_bytes_sum = 0;
    const cudaError_t sum_query_rc = fullmag::fem::fullmag_cuda_device_sum(
        d_input.get(), count, d_result.get(), nullptr, temp_bytes_sum, nullptr);
    check(sum_query_rc == cudaSuccess,
          "fullmag_cuda_device_sum query mode must return cudaSuccess");
    check(temp_bytes_sum > 0, "sum query temp_storage_bytes must be > 0");

    const size_t alloc_temp_bytes =
        std::max({temp_bytes_max, temp_bytes_min, temp_bytes_sum});
    DeviceBuffer<char> d_temp(alloc_temp_bytes);

    // Normal execution
    size_t cur_bytes = alloc_temp_bytes;
    const cudaError_t max_exec_rc = fullmag::fem::fullmag_cuda_device_max(
        d_input.get(), count, d_result.get(), d_temp.get(), cur_bytes, nullptr);
    check(max_exec_rc == cudaSuccess, "valid max reduction must return cudaSuccess");
    std::vector<double> out = d_result.copy_to_host();
    check(close(out[0], 84.5), "valid max reduction output must match 84.5");

    cur_bytes = alloc_temp_bytes;
    const cudaError_t min_exec_rc = fullmag::fem::fullmag_cuda_device_min(
        d_input.get(), count, d_result.get(), d_temp.get(), cur_bytes, nullptr);
    check(min_exec_rc == cudaSuccess, "valid min reduction must return cudaSuccess");
    out = d_result.copy_to_host();
    check(close(out[0], -123.4), "valid min reduction output must match -123.4");

    cur_bytes = alloc_temp_bytes;
    const cudaError_t sum_exec_rc = fullmag::fem::fullmag_cuda_device_sum(
        d_input.get(), count, d_result.get(), d_temp.get(), cur_bytes, nullptr);
    check(sum_exec_rc == cudaSuccess, "valid sum reduction must return cudaSuccess");
    out = d_result.copy_to_host();
    check(close(out[0], expected_sum, 1.0e-9), "valid sum reduction output must match expected sum");

    // Task A04 RED verification: CUB API error with clean cudaPeekAtLastError and stale finite scalar
    const double stale_sentinel = 42.123456789;
    out[0] = stale_sentinel;

    // Test max:
    d_result.copy_from(out);
    cudaGetLastError(); // Clear any existing CUDA errors
    size_t bad_temp_bytes = 0; // CUB returns cudaErrorInvalidValue when temp_storage != nullptr but temp_bytes is insufficient
    const cudaError_t bad_max_rc = fullmag::fem::fullmag_cuda_device_max(
        d_input.get(), count, d_result.get(), d_temp.get(), bad_temp_bytes, nullptr);
    check(bad_max_rc != cudaSuccess,
          "fullmag_cuda_device_max with 0 temp_storage_bytes must return an immediate error");
    check(cudaPeekAtLastError() == cudaSuccess,
          "cudaPeekAtLastError must remain cudaSuccess when CUB returns host API validation error");
    out = d_result.copy_to_host();
    check(close(out[0], stale_sentinel),
          "destination scalar must retain stale sentinel value when CUB API call fails");

    // Test min:
    out[0] = stale_sentinel;
    d_result.copy_from(out);
    cudaGetLastError();
    bad_temp_bytes = 0;
    const cudaError_t bad_min_rc = fullmag::fem::fullmag_cuda_device_min(
        d_input.get(), count, d_result.get(), d_temp.get(), bad_temp_bytes, nullptr);
    check(bad_min_rc != cudaSuccess,
          "fullmag_cuda_device_min with 0 temp_storage_bytes must return an immediate error");
    check(cudaPeekAtLastError() == cudaSuccess,
          "cudaPeekAtLastError must remain cudaSuccess for fullmag_cuda_device_min host API error");
    out = d_result.copy_to_host();
    check(close(out[0], stale_sentinel),
          "destination scalar must retain stale sentinel value for failed min reduction");

    // Test sum:
    out[0] = stale_sentinel;
    d_result.copy_from(out);
    cudaGetLastError();
    bad_temp_bytes = 0;
    const cudaError_t bad_sum_rc = fullmag::fem::fullmag_cuda_device_sum(
        d_input.get(), count, d_result.get(), d_temp.get(), bad_temp_bytes, nullptr);
    check(bad_sum_rc != cudaSuccess,
          "fullmag_cuda_device_sum with 0 temp_storage_bytes must return an immediate error");
    check(cudaPeekAtLastError() == cudaSuccess,
          "cudaPeekAtLastError must remain cudaSuccess for fullmag_cuda_device_sum host API error");
    out = d_result.copy_to_host();
    check(close(out[0], stale_sentinel),
          "destination scalar must retain stale sentinel value for failed sum reduction");
}

} // namespace

int main()
{
    check_resolver_contract();
    check_diagonal_builder_validation();
    check_dense_oracle_separates_diagonal_from_sparse();
    check_diagonal_host_and_device_contract();
    check_sparse_exchange_mass_fixed_cg_contract();
    check_sparse_exchange_mass_mask_and_failure_contract();
    check_pgbb_raw_gradient_fallback_contract();
    check_ncg_preconditioned_pr_plus_parity_contract();
    check_direct_minimizer_all_preconditioner_profiles_and_latch_recovery_contract();
    check_cub_reduction_status_propagation_contract();

    auto strip_cr = [](std::string &s) {
        s.erase(std::remove(s.begin(), s.end(), '\r'), s.end());
    };

    // Preserve the integrated full-potential source wiring checks while the
    // focused device tests above own the numerical preconditioner contract.
    std::ifstream ncg_file("/workspace/backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp");
    if (!ncg_file.is_open()) ncg_file.open("backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp");
    if (!ncg_file.is_open()) ncg_file.open("../backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp");
    check(ncg_file.is_open(), "unable to open nonlinear_cg.cpp");
    std::string ncg_src((std::istreambuf_iterator<char>(ncg_file)), std::istreambuf_iterator<char>());
    strip_cr(ncg_src);
    check(ncg_src.find("gpu_relaxation_apply_preconditioner") != std::string::npos,
          "nonlinear_cg.cpp must wire gpu_relaxation_apply_preconditioner");
    check(ncg_src.find("gpu_relaxation_is_preconditioned(gpu.relaxation)") != std::string::npos,
          "nonlinear_cg.cpp must check gpu_relaxation_is_preconditioned");
    check(ncg_src.find("gpu.relaxation.preconditioner.is_active()") == std::string::npos,
          "nonlinear_cg.cpp must not check only diagonal preconditioner.is_active()");
    check(ncg_src.find("kNcgCurrentPreconditionerFailureTailSlot") != std::string::npos,
          "nonlinear_cg.cpp must define kNcgCurrentPreconditionerFailureTailSlot");
    check(ncg_src.find("kNcgAcceptedPreconditionerFailureTailSlot") != std::string::npos,
          "nonlinear_cg.cpp must define kNcgAcceptedPreconditionerFailureTailSlot");
    check(ncg_src.find("gpu_relaxation_enqueue_preconditioner_failure") != std::string::npos,
          "nonlinear_cg.cpp must enqueue preconditioner failure latch");

    std::ifstream pgbb_file("/workspace/backends/fem/gpu/cuda/relaxation/pgbb.cpp");
    if (!pgbb_file.is_open()) pgbb_file.open("backends/fem/gpu/cuda/relaxation/pgbb.cpp");
    if (!pgbb_file.is_open()) pgbb_file.open("../backends/fem/gpu/cuda/relaxation/pgbb.cpp");
    check(pgbb_file.is_open(), "unable to open pgbb.cpp");
    std::string pgbb_src((std::istreambuf_iterator<char>(pgbb_file)), std::istreambuf_iterator<char>());
    strip_cr(pgbb_src);
    check(pgbb_src.find("gpu_relaxation_apply_preconditioner") != std::string::npos,
          "pgbb.cpp must dispatch preconditioning through the relaxation lifecycle");

    // Task 4 RED contracts: PG-BB must resolve/setup a selected strategy,
    // preserve raw g, write z to a distinct persistent field, and consume
    // exchange-CG failures through the packed scalar control packet.
    check(pgbb_src.find("gpu_relaxation_prepare_preconditioner") != std::string::npos,
          "PG-BB must prepare the resolved preconditioner before metrics");
    check(pgbb_src.find("operator_lifecycle.setup_complete") != std::string::npos,
          "PG-BB must require a completed MFEM exchange operator lifecycle");
    check(pgbb_src.find("key.fe_order") != std::string::npos,
          "PG-BB preconditioner identity must include the finite-element order");
    check(pgbb_src.find("preconditioned_gradient") != std::string::npos,
          "PG-BB must keep a persistent preconditioned-gradient z buffer");
    check(pgbb_src.find("gpu_relaxation_apply_preconditioner") != std::string::npos,
          "PG-BB must dispatch the selected preconditioner instead of an in-place diagonal apply");
    check(pgbb_src.find("kGpuPgbbCurrentPreconditionerFailureSlot") != std::string::npos,
          "PG-BB must consume the preconditioner failure latch in its existing scalar packet");
    check(pgbb_src.find("gpu_relaxation_enqueue_preconditioner_failure") !=
              std::string::npos,
          "PG-BB must enqueue the preconditioner failure latch");
    std::ifstream metrics_file(
        "/workspace/backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp");
    if (!metrics_file.is_open()) {
        metrics_file.open(
            "backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp");
    }
    if (!metrics_file.is_open()) {
        metrics_file.open(
            "../backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp");
    }
    check(metrics_file.is_open(), "unable to open direct_energy_increment.cpp");
    std::string metrics_src(
        (std::istreambuf_iterator<char>(metrics_file)),
        std::istreambuf_iterator<char>());
    strip_cr(metrics_src);
    check(metrics_src.find("metrics.preconditioner_failure") !=
              std::string::npos,
          "PG-BB metrics unpack must fail closed on the preconditioner failure latch");
    check(pgbb_src.find("gpu.rk.k[0].x,\n        gpu.rk.k[0].y,\n        gpu.rk.k[0].z,\n        gpu.rk.k[0].x") == std::string::npos,
          "PG-BB must not overwrite raw g with z in the same field");
    check(pgbb_src.find(
              "gpu.rk.k[0],\n                gpu.relaxation.preconditioned_gradient,") !=
              std::string::npos,
          "PG-BB raw-gradient recovery must copy g into the distinct z field");

    std::ifstream exchange_upload_file(
        "/workspace/backends/fem/cpu/mfem/interactions/exchange_legacy_gpu_upload.cpp");
    if (!exchange_upload_file.is_open()) {
        exchange_upload_file.open(
            "backends/fem/cpu/mfem/interactions/exchange_legacy_gpu_upload.cpp");
    }
    if (!exchange_upload_file.is_open()) {
        exchange_upload_file.open(
            "../backends/fem/cpu/mfem/interactions/exchange_legacy_gpu_upload.cpp");
    }
    check(exchange_upload_file.is_open(),
          "unable to open exchange_legacy_gpu_upload.cpp");
    std::string exchange_upload_src(
        (std::istreambuf_iterator<char>(exchange_upload_file)),
        std::istreambuf_iterator<char>());
    strip_cr(exchange_upload_src);
    check(exchange_upload_src.find("canonical_values, true, error") !=
              std::string::npos,
          "legacy GPU exchange upload must materialize the Laplacian diagonal for M+wK");

    std::ifstream context_file(
        "/workspace/backends/fem/cpu/mfem/runtime/mfem_context.cpp");
    if (!context_file.is_open()) {
        context_file.open("backends/fem/cpu/mfem/runtime/mfem_context.cpp");
    }
    if (!context_file.is_open()) {
        context_file.open("../backends/fem/cpu/mfem/runtime/mfem_context.cpp");
    }
    check(context_file.is_open(), "unable to open mfem_context.cpp");
    std::string context_src(
        (std::istreambuf_iterator<char>(context_file)),
        std::istreambuf_iterator<char>());
    strip_cr(context_src);
    check(context_src.find("canonical_values, true, error") != std::string::npos,
          "PG-BB preconditioner inputs must retain the full exchange diagonal");
    check(context_src.find("GPU relaxation preconditioner setup masks do not match MFEM dimensions") !=
              std::string::npos,
          "PG-BB preconditioner setup must reject mask dimensions that do not match MFEM");

    std::ifstream state_file("/workspace/backends/fem/gpu/cuda/relaxation/relaxation_state.hpp");
    if (!state_file.is_open()) state_file.open("backends/fem/gpu/cuda/relaxation/relaxation_state.hpp");
    if (!state_file.is_open()) state_file.open("../backends/fem/gpu/cuda/relaxation/relaxation_state.hpp");
    check(state_file.is_open(), "unable to open relaxation_state.hpp");
    std::string state_src((std::istreambuf_iterator<char>(state_file)), std::istreambuf_iterator<char>());
    strip_cr(state_src);
    check(state_src.find("preconditioned_gradient") != std::string::npos,
          "relaxation state must own the persistent z field");
    check(state_src.find("exchange_mass_cg4") != std::string::npos &&
              state_src.find("exchange_mass_cg8") != std::string::npos,
          "relaxation state must own concrete CG4 and CG8 dispatch objects");
    check(state_src.find("GpuRelaxationPreconditionerSetupIdentity") != std::string::npos,
          "relaxation state must retain setup identity for invalidation");
    std::printf("PASS: gpu_relaxation_preconditioner_contract\n");
    return 0;
}

#include "gpu/cuda/relaxation/gpu_relaxation_preconditioner.hpp"

#include <cmath>
#include <cstdlib>
#include <string>
#include <vector>

namespace {

void check(bool condition)
{
    if (!condition) std::abort();
}

struct ManufacturedSpdMatrix {
    std::vector<double> diag;
    std::vector<double> mult(const std::vector<double> &x) const {
        std::vector<double> y(x.size(), 0.0);
        for (size_t i = 0; i < x.size(); ++i) {
            y[i] = diag[i] * x[i];
        }
        return y;
    }
};

double relative_residual(
    const ManufacturedSpdMatrix &op,
    const std::vector<double> &solution,
    const std::vector<double> &rhs)
{
    auto ax = op.mult(solution);
    double num_sq = 0.0;
    double den_sq = 0.0;
    for (size_t i = 0; i < rhs.size(); ++i) {
        double r = ax[i] - rhs[i];
        num_sq += r * r;
        den_sq += rhs[i] * rhs[i];
    }
    return std::sqrt(num_sq) / std::max(1.0e-30, std::sqrt(den_sq));
}

} // namespace

int main()
{
    using namespace fullmag::fem;
    GpuRelaxationPreconditionerDecision decision;
    std::string error;
    check(resolve_gpu_relaxation_preconditioner({}, decision, error));
    check(decision.kind == GpuRelaxationPreconditionerKind::None);

    GpuRelaxationPreconditionerRequest diagonal;
    diagonal.requested_kind = "diagonal";
    check(!resolve_gpu_relaxation_preconditioner(diagonal, decision, error));
    diagonal.profile_qualified = true;
    check(resolve_gpu_relaxation_preconditioner(diagonal, decision, error));
    check(decision.kind == GpuRelaxationPreconditionerKind::Diagonal);
    diagonal.profile_stale = true;
    check(!resolve_gpu_relaxation_preconditioner(diagonal, decision, error));

    std::vector<double> out;
    check(build_gpu_relaxation_diagonal(
        {2.0, 3.0, 4.0}, {1.0, -1.0, 2.0}, 0.5, {1u, 0u, 1u}, out, error));
    check(out == std::vector<double>({2.5, 0.0, 5.0}));
    check(!build_gpu_relaxation_diagonal(
        {1.0}, {0.0}, -3.0, {1u}, out, error));
    check(!build_gpu_relaxation_diagonal(
        {1.0}, {0.0}, 1.0, {0u, 1u}, out, error));

    // Step 1: Manufactured SPD test for GpuExchangeMassPreconditioner
    GpuRelaxationPreconditionerRequest exchange_mass_req;
    exchange_mass_req.requested_kind = "exchange_mass";
    check(!resolve_gpu_relaxation_preconditioner(exchange_mass_req, decision, error));
    exchange_mass_req.profile_qualified = true;
    check(resolve_gpu_relaxation_preconditioner(exchange_mass_req, decision, error));
    check(decision.kind == GpuRelaxationPreconditionerKind::ExchangeMass);

    GpuExchangeMassPreconditioner preconditioner;
    std::vector<double> mass = {2.0, 3.0, 4.0};
    std::vector<double> exchange = {1.0, 2.0, 3.0};
    double weight = 0.5;
    check(preconditioner.setup(mass, exchange, weight, nullptr, error));
    check(preconditioner.setup_count() == 1);

    // Repeated setup with same parameters reuses existing setup
    check(preconditioner.setup(mass, exchange, weight, nullptr, error));
    check(preconditioner.setup_count() == 1);

    std::vector<double> rhs = {1.0, 2.0, 3.0};
    std::vector<double> solution;
    check(preconditioner.apply_host(rhs, solution, error));
    check(preconditioner.apply_count() == 1);

    // Compute relative residual for manufactured SPD: (M + w K) * solution = M * rhs
    ManufacturedSpdMatrix mass_plus_weight_exchange;
    mass_plus_weight_exchange.diag.resize(mass.size());
    std::vector<double> mass_rhs(mass.size());
    for (size_t i = 0; i < mass.size(); ++i) {
        mass_plus_weight_exchange.diag[i] = mass[i] + weight * exchange[i];
        mass_rhs[i] = mass[i] * rhs[i];
    }
    const double rel_res = relative_residual(mass_plus_weight_exchange, solution, mass_rhs);
    check(rel_res <= 1.0e-10);

    return 0;
}

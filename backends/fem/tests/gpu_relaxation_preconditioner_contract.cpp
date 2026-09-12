#include "gpu/cuda/relaxation/gpu_relaxation_preconditioner.hpp"

#include <cstdlib>
#include <string>
#include <vector>

namespace {
void check(bool condition)
{
    if (!condition) std::abort();
}
}

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
    return 0;
}

#include "gpu/cuda/exchange/exchange_operator.hpp"

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
    const std::vector<uint32_t> rows{0, 4, 7, 8};
    const std::vector<uint32_t> cols{0, 2, 2, 1, 0, 1, 2, 2};
    const std::vector<double> values{4.0, 1.0, 2.0, 3.0, 5.0, -1.0, 7.0, 9.0};
    GpuExchangeOffDiagonalCsr csr;
    std::string error;
    check(build_gpu_exchange_off_diagonal_csr(3, rows, cols, values, csr, error));
    check(csr.row_offsets == std::vector<uint32_t>({0, 2, 4, 4}));
    check(csr.col_indices == std::vector<uint32_t>({1, 2, 0, 2}));
    check(csr.values == std::vector<double>({3.0, 3.0, 5.0, 7.0}));
    check(csr.digest != 0);

    GpuExchangePeriodicReducedCsr reduced;
    check(build_gpu_exchange_periodic_reduced_csr(
        4,
        {0u, 2u, 4u, 6u, 8u},
        {0u, 2u, 1u, 3u, 2u, 0u, 3u, 1u},
        {1.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0},
        {1.0, 2.0, 3.0, 4.0},
        {0u, 0u, 1u, 1u},
        {0u, 2u},
        2u,
        reduced,
        error));
    check(reduced.row_offsets == std::vector<uint32_t>({0u, 1u, 2u}));
    check(reduced.col_indices == std::vector<uint32_t>({1u, 0u}));
    check(reduced.values == std::vector<double>({4.0, 12.0}));
    check(reduced.reduced_mass == std::vector<double>({3.0, 7.0}));
    check(reduced.digest != 0);
    check(!build_gpu_exchange_periodic_reduced_csr(
        4,
        {0u, 2u, 4u, 6u, 8u},
        {0u, 2u, 1u, 3u, 2u, 0u, 3u, 1u},
        {1.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0},
        {1.0, 2.0, 3.0, 4.0},
        {0u, 0u, 1u, 1u},
        {1u, 1u},
        2u,
        reduced,
        error));
    GpuExchangeOperatorKind kind = GpuExchangeOperatorKind::LegacySparse;
    check(resolve_gpu_exchange_operator_kind("legacy_sparse_gpu", true, kind, error));
    check(kind == GpuExchangeOperatorKind::LegacySparse);
    check(!resolve_gpu_exchange_operator_kind("partial_assembly_gpu", false, kind, error));
    check(!resolve_gpu_exchange_operator_kind("bogus", true, kind, error));
    GpuExchangePlannerDecision decision;
    check(plan_gpu_exchange_operator({}, decision, error));
    check(decision.kind == GpuExchangeOperatorKind::LegacySparse &&
        decision.compatibility_mode);
    GpuExchangePlannerRequest stale;
    stale.requested_kind = "fused_xyz_gpu";
    stale.profile_qualified = true;
    stale.profile_stale = true;
    check(!plan_gpu_exchange_operator(stale, decision, error));
    GpuExchangePlannerRequest unqualified;
    unqualified.requested_kind = "partial_assembly_gpu";
    check(!plan_gpu_exchange_operator(unqualified, decision, error));
    GpuExchangePlannerRequest no_runtime;
    no_runtime.requested_kind = "fused_xyz_gpu";
    no_runtime.profile_qualified = true;
    check(!plan_gpu_exchange_operator(no_runtime, decision, error));
    GpuExchangePlannerRequest qualified;
    qualified.requested_kind = "fused_xyz_gpu";
    qualified.profile_qualified = true;
    qualified.runtime_supported = true;
    check(plan_gpu_exchange_operator(qualified, decision, error));
    check(decision.kind == GpuExchangeOperatorKind::FusedXYZ &&
        !decision.compatibility_mode);
    GpuExchangePlannerRequest vram;
    vram.vram_preflight_ok = false;
    check(!plan_gpu_exchange_operator(vram, decision, error));
    return 0;
}

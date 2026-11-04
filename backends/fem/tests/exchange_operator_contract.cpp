#include "gpu/cuda/exchange/exchange_operator.hpp"

#include <cstdint>
#include <cstdlib>
#include <limits>
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
        {},
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
        {},
        {0u, 0u, 1u, 1u},
        {1u, 1u},
        2u,
        reduced,
        error));

    const std::vector<uint32_t> airbox_rows{0u, 1u, 2u, 4u, 4u, 4u};
    const std::vector<uint32_t> airbox_cols{2u, 2u, 0u, 1u};
    const std::vector<double> airbox_values{-2.0, -3.0, -2.0, -3.0};
    const std::vector<double> airbox_masses{1.0, 2.0, 3.0, 0.0, 0.0};
    const std::vector<uint32_t> airbox_reduced_node{0u, 0u, 1u, 2u, 2u};
    const std::vector<uint32_t> airbox_representatives{0u, 2u, 3u};
    const std::vector<std::uint8_t> airbox_magnetic_node_mask{1u, 1u, 1u, 0u, 0u};
    GpuExchangePeriodicReducedCsr airbox_reduced;
    check(build_gpu_exchange_periodic_reduced_csr(
        5u,
        airbox_rows,
        airbox_cols,
        airbox_values,
        airbox_masses,
        airbox_magnetic_node_mask,
        airbox_reduced_node,
        airbox_representatives,
        3u,
        airbox_reduced,
        error));
    check(airbox_reduced.reduced_mass == std::vector<double>({3.0, 3.0, 0.0}));
    check(airbox_reduced.row_offsets == std::vector<uint32_t>({0u, 1u, 2u, 2u}));
    check(airbox_reduced.col_indices == std::vector<uint32_t>({1u, 0u}));
    check(airbox_reduced.values == std::vector<double>({-5.0, -5.0}));

    GpuExchangePeriodicReducedCsr structural_zero;
    check(build_gpu_exchange_periodic_reduced_csr(
        2u,
        {0u, 2u, 4u},
        {1u, 1u, 0u, 0u},
        {1.0, -1.0, 1.0, -1.0},
        {1.0, 1.0},
        {},
        {0u, 1u},
        {0u, 1u},
        2u,
        structural_zero,
        error));
    check(structural_zero.row_offsets == std::vector<uint32_t>({0u, 1u, 2u}));
    check(structural_zero.col_indices == std::vector<uint32_t>({1u, 0u}));
    check(structural_zero.values == std::vector<double>({0.0, 0.0}));

    check(!build_gpu_exchange_periodic_reduced_csr(
        5u,
        airbox_rows,
        airbox_cols,
        airbox_values,
        airbox_masses,
        {},
        airbox_reduced_node,
        airbox_representatives,
        3u,
        airbox_reduced,
        error));
    auto active_airbox_mask = airbox_magnetic_node_mask;
    active_airbox_mask[3] = 1u;
    check(!build_gpu_exchange_periodic_reduced_csr(
        5u,
        airbox_rows,
        airbox_cols,
        airbox_values,
        airbox_masses,
        active_airbox_mask,
        airbox_reduced_node,
        airbox_representatives,
        3u,
        airbox_reduced,
        error));

    check(!build_gpu_exchange_periodic_reduced_csr(
        4u,
        {0u, 1u, 1u, 1u, 1u},
        {3u},
        {-1.0},
        {1.0, 1.0, 1.0, 0.0},
        {1u, 1u, 1u, 0u},
        {0u, 1u, 2u, 3u},
        {0u, 1u, 2u, 3u},
        4u,
        airbox_reduced,
        error));

    auto negative_airbox_masses = airbox_masses;
    negative_airbox_masses[3] = -1.0;
    check(!build_gpu_exchange_periodic_reduced_csr(
        5u,
        airbox_rows,
        airbox_cols,
        airbox_values,
        negative_airbox_masses,
        airbox_magnetic_node_mask,
        airbox_reduced_node,
        airbox_representatives,
        3u,
        airbox_reduced,
        error));
    auto nonfinite_airbox_masses = airbox_masses;
    nonfinite_airbox_masses[4] = std::numeric_limits<double>::infinity();
    check(!build_gpu_exchange_periodic_reduced_csr(
        5u,
        airbox_rows,
        airbox_cols,
        airbox_values,
        nonfinite_airbox_masses,
        airbox_magnetic_node_mask,
        airbox_reduced_node,
        airbox_representatives,
        3u,
        airbox_reduced,
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

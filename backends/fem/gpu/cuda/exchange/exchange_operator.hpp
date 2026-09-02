#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

enum class GpuExchangeOperatorKind {
    LegacySparse,
    FusedXYZ,
    PeriodicReduced,
    CuSparse,
    PartialAssembly,
};

const char *gpu_exchange_operator_kind_id(GpuExchangeOperatorKind kind) noexcept;

bool parse_gpu_exchange_operator_kind(
    const std::string &id,
    GpuExchangeOperatorKind &kind,
    std::string &error);

bool resolve_gpu_exchange_operator_kind(
    const std::string &requested_id,
    bool profile_qualified,
    GpuExchangeOperatorKind &kind,
    std::string &error);

struct GpuExchangePlannerRequest {
    std::string requested_kind;
    bool profile_qualified = false;
    bool profile_stale = false;
    bool vram_preflight_ok = true;
    bool runtime_supported = false;
};

struct GpuExchangePlannerDecision {
    GpuExchangeOperatorKind kind = GpuExchangeOperatorKind::LegacySparse;
    bool compatibility_mode = true;
};

/* Deterministic setup-time resolver.  It never autotunes and never silently
 * substitutes legacy exchange for an explicitly requested unqualified,
 * stale, VRAM-incompatible, or runtime-unsupported profile. */
bool plan_gpu_exchange_operator(
    const GpuExchangePlannerRequest &request,
    GpuExchangePlannerDecision &decision,
    std::string &error);

struct GpuExchangeOffDiagonalCsr {
    std::vector<uint32_t> row_offsets;
    std::vector<uint32_t> col_indices;
    std::vector<double> values;
    uint64_t digest = 0;
};

struct GpuExchangePeriodicReducedCsr {
    std::vector<uint32_t> row_offsets;
    std::vector<uint32_t> col_indices;
    std::vector<double> values;
    std::vector<double> reduced_mass;
    uint64_t digest = 0;
};

bool build_gpu_exchange_off_diagonal_csr(
    uint32_t rows,
    const std::vector<uint32_t> &row_offsets,
    const std::vector<uint32_t> &col_indices,
    const std::vector<double> &values,
    GpuExchangeOffDiagonalCsr &out,
    std::string &error);

bool build_gpu_exchange_periodic_reduced_csr(
    uint32_t rows,
    const std::vector<uint32_t> &row_offsets,
    const std::vector<uint32_t> &col_indices,
    const std::vector<double> &values,
    const std::vector<double> &lumped_mass,
    const std::vector<uint32_t> &reduced_node,
    const std::vector<uint32_t> &representative_nodes,
    uint32_t reduced_rows,
    GpuExchangePeriodicReducedCsr &out,
    std::string &error);

} // namespace fullmag::fem

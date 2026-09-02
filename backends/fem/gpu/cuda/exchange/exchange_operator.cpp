#include "gpu/cuda/exchange/exchange_operator.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <map>

namespace fullmag::fem {

const char *gpu_exchange_operator_kind_id(GpuExchangeOperatorKind kind) noexcept
{
    switch (kind) {
    case GpuExchangeOperatorKind::LegacySparse: return "legacy_sparse_gpu";
    case GpuExchangeOperatorKind::FusedXYZ: return "fused_xyz_gpu";
    case GpuExchangeOperatorKind::PeriodicReduced: return "periodic_reduced_gpu";
    case GpuExchangeOperatorKind::CuSparse: return "cusparse_spmv_gpu";
    case GpuExchangeOperatorKind::PartialAssembly: return "partial_assembly_gpu";
    }
    return "unsupported";
}

bool parse_gpu_exchange_operator_kind(
    const std::string &id,
    GpuExchangeOperatorKind &kind,
    std::string &error)
{
    if (id == "legacy_sparse_gpu") {
        kind = GpuExchangeOperatorKind::LegacySparse;
    } else if (id == "fused_xyz_gpu") {
        kind = GpuExchangeOperatorKind::FusedXYZ;
    } else if (id == "periodic_reduced_gpu") {
        kind = GpuExchangeOperatorKind::PeriodicReduced;
    } else if (id == "cusparse_spmv_gpu") {
        kind = GpuExchangeOperatorKind::CuSparse;
    } else if (id == "partial_assembly_gpu") {
        kind = GpuExchangeOperatorKind::PartialAssembly;
    } else {
        error = "unsupported GPU exchange operator kind: " + id;
        return false;
    }
    error.clear();
    return true;
}

bool resolve_gpu_exchange_operator_kind(
    const std::string &requested_id,
    bool profile_qualified,
    GpuExchangeOperatorKind &kind,
    std::string &error)
{
    const std::string id = requested_id.empty() ? "legacy_sparse_gpu" : requested_id;
    if (!parse_gpu_exchange_operator_kind(id, kind, error)) {
        return false;
    }
    // Compatibility and fused paths share the currently qualified legacy
    // artifact. New operator families remain explicit fail-closed profiles.
    if ((kind == GpuExchangeOperatorKind::PeriodicReduced ||
         kind == GpuExchangeOperatorKind::CuSparse ||
         kind == GpuExchangeOperatorKind::PartialAssembly) && !profile_qualified) {
        error = "GPU exchange operator profile is not qualified: " + id;
        return false;
    }
    if (kind == GpuExchangeOperatorKind::FusedXYZ && !profile_qualified) {
        error = "GPU fused XYZ exchange profile is not qualified: " + id;
        return false;
    }
    error.clear();
    return true;
}

bool plan_gpu_exchange_operator(
    const GpuExchangePlannerRequest &request,
    GpuExchangePlannerDecision &decision,
    std::string &error)
{
    decision = {};
    const bool is_default = request.requested_kind.empty();
    if (request.profile_stale) {
        error = "GPU exchange operator profile is stale";
        return false;
    }
    if (!request.vram_preflight_ok) {
        error = "GPU exchange operator profile failed VRAM preflight";
        return false;
    }
    GpuExchangeOperatorKind kind = GpuExchangeOperatorKind::LegacySparse;
    if (!resolve_gpu_exchange_operator_kind(
            request.requested_kind,
            is_default || request.profile_qualified,
            kind,
            error)) {
        return false;
    }
    if (!is_default && kind != GpuExchangeOperatorKind::LegacySparse &&
        !request.runtime_supported) {
        error = "GPU exchange operator profile has no qualified runtime implementation: " +
            std::string(gpu_exchange_operator_kind_id(kind));
        return false;
    }
    decision.kind = kind;
    decision.compatibility_mode = kind == GpuExchangeOperatorKind::LegacySparse;
    error.clear();
    return true;
}

namespace {

uint64_t fnv1a_append(uint64_t hash, uint64_t value) noexcept
{
    constexpr uint64_t kPrime = 1099511628211ull;
    for (unsigned shift = 0; shift < 64; shift += 8) {
        hash ^= (value >> shift) & 0xffu;
        hash *= kPrime;
    }
    return hash;
}

} // namespace

bool build_gpu_exchange_off_diagonal_csr(
    uint32_t rows,
    const std::vector<uint32_t> &row_offsets,
    const std::vector<uint32_t> &col_indices,
    const std::vector<double> &values,
    GpuExchangeOffDiagonalCsr &out,
    std::string &error)
{
    out = {};
    if (rows == 0 || row_offsets.size() != static_cast<size_t>(rows) + 1u ||
        row_offsets.front() != 0u || row_offsets.back() != col_indices.size() ||
        col_indices.size() != values.size()) {
        error = "GPU exchange off-diagonal CSR dimensions are invalid";
        return false;
    }
    out.row_offsets.reserve(static_cast<size_t>(rows) + 1u);
    out.row_offsets.push_back(0u);
    for (uint32_t row = 0; row < rows; ++row) {
        if (row_offsets[row] > row_offsets[row + 1u]) {
            error = "GPU exchange CSR row offsets are not monotonic";
            return false;
        }
        std::map<uint32_t, double> merged;
        for (uint32_t p = row_offsets[row]; p < row_offsets[row + 1u]; ++p) {
            const uint32_t col = col_indices[p];
            if (col >= rows) {
                error = "GPU exchange CSR column is out of bounds";
                return false;
            }
            if (col == row) {
                continue;
            }
            if (!std::isfinite(values[p])) {
                error = "GPU exchange CSR value is non-finite";
                return false;
            }
            merged[col] += values[p];
        }
        for (const auto &[col, value] : merged) {
            if (!std::isfinite(value)) {
                error = "GPU exchange CSR duplicate merge is non-finite";
                return false;
            }
            out.col_indices.push_back(col);
            out.values.push_back(value);
        }
        if (out.col_indices.size() > std::numeric_limits<uint32_t>::max()) {
            error = "GPU exchange off-diagonal CSR exceeds u32 indexing";
            return false;
        }
        out.row_offsets.push_back(static_cast<uint32_t>(out.col_indices.size()));
    }
    uint64_t hash = 1469598103934665603ull;
    for (uint32_t value : out.row_offsets) hash = fnv1a_append(hash, value);
    for (uint32_t value : out.col_indices) hash = fnv1a_append(hash, value);
    for (double value : out.values) {
        uint64_t bits = 0;
        static_assert(sizeof(bits) == sizeof(value));
        std::memcpy(&bits, &value, sizeof(bits));
        hash = fnv1a_append(hash, bits);
    }
    out.digest = hash;
    error.clear();
    return true;
}

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
    std::string &error)
{
    out = {};
    if (rows == 0u || reduced_rows == 0u ||
        row_offsets.size() != static_cast<size_t>(rows) + 1u ||
        row_offsets.front() != 0u || row_offsets.back() != col_indices.size() ||
        col_indices.size() != values.size() || lumped_mass.size() != rows ||
        reduced_node.size() != rows || representative_nodes.size() != reduced_rows) {
        error = "GPU periodic reduced exchange dimensions are invalid";
        return false;
    }
    std::vector<uint8_t> class_seen(reduced_rows, 0u);
    std::vector<std::map<uint32_t, double>> rows_by_class(reduced_rows);
    out.reduced_mass.assign(reduced_rows, 0.0);
    for (uint32_t row = 0; row < rows; ++row) {
        if (row_offsets[row] > row_offsets[row + 1u]) {
            error = "GPU periodic reduced exchange row offsets are not monotonic";
            return false;
        }
        const uint32_t reduced_row = reduced_node[row];
        if (reduced_row >= reduced_rows || !std::isfinite(lumped_mass[row]) ||
            lumped_mass[row] < 0.0) {
            error = "GPU periodic reduced exchange class or mass is invalid";
            return false;
        }
        class_seen[reduced_row] = 1u;
        out.reduced_mass[reduced_row] += lumped_mass[row];
        for (uint32_t p = row_offsets[row]; p < row_offsets[row + 1u]; ++p) {
            const uint32_t col = col_indices[p];
            if (col >= rows || !std::isfinite(values[p])) {
                error = "GPU periodic reduced exchange CSR entry is invalid";
                return false;
            }
            const uint32_t reduced_col = reduced_node[col];
            if (reduced_col >= reduced_rows) {
                error = "GPU periodic reduced exchange column class is invalid";
                return false;
            }
            if (reduced_col != reduced_row) {
                rows_by_class[reduced_row][reduced_col] += values[p];
            }
        }
    }
    for (uint32_t reduced = 0; reduced < reduced_rows; ++reduced) {
        const uint32_t representative = representative_nodes[reduced];
        if (class_seen[reduced] == 0u || representative >= rows ||
            reduced_node[representative] != reduced ||
            !std::isfinite(out.reduced_mass[reduced]) ||
            out.reduced_mass[reduced] <= 0.0) {
            error = "GPU periodic reduced exchange representative or mass is invalid";
            return false;
        }
    }
    out.row_offsets.reserve(static_cast<size_t>(reduced_rows) + 1u);
    out.row_offsets.push_back(0u);
    for (uint32_t reduced = 0; reduced < reduced_rows; ++reduced) {
        for (const auto &[col, value] : rows_by_class[reduced]) {
            if (!std::isfinite(value)) {
                error = "GPU periodic reduced exchange duplicate merge is non-finite";
                return false;
            }
            out.col_indices.push_back(col);
            out.values.push_back(value);
        }
        if (out.col_indices.size() > std::numeric_limits<uint32_t>::max()) {
            error = "GPU periodic reduced exchange CSR exceeds u32 indexing";
            return false;
        }
        out.row_offsets.push_back(static_cast<uint32_t>(out.col_indices.size()));
    }
    uint64_t hash = 1469598103934665603ull;
    for (uint32_t value : out.row_offsets) hash = fnv1a_append(hash, value);
    for (uint32_t value : out.col_indices) hash = fnv1a_append(hash, value);
    for (double value : out.values) {
        uint64_t bits = 0;
        std::memcpy(&bits, &value, sizeof(bits));
        hash = fnv1a_append(hash, bits);
    }
    for (double value : out.reduced_mass) {
        uint64_t bits = 0;
        std::memcpy(&bits, &value, sizeof(bits));
        hash = fnv1a_append(hash, bits);
    }
    out.digest = hash;
    error.clear();
    return true;
}

} // namespace fullmag::fem

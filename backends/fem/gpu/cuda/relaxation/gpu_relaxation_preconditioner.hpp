#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

enum class GpuRelaxationPreconditionerKind {
    None,
    Diagonal,
};

const char *gpu_relaxation_preconditioner_kind_id(
    GpuRelaxationPreconditionerKind kind) noexcept;

struct GpuRelaxationPreconditionerRequest {
    std::string requested_kind;
    bool profile_qualified = false;
    bool profile_stale = false;
};

struct GpuRelaxationPreconditionerDecision {
    GpuRelaxationPreconditionerKind kind =
        GpuRelaxationPreconditionerKind::None;
    bool qualified = false;
};

/* Resolve only explicitly qualified profiles.  Empty input selects the
 * existing unpreconditioned baseline; an unqualified/stale diagonal profile
 * fails closed rather than changing NCG/PG-BB arithmetic silently. */
bool resolve_gpu_relaxation_preconditioner(
    const GpuRelaxationPreconditionerRequest &request,
    GpuRelaxationPreconditionerDecision &decision,
    std::string &error);

/* Host-side oracle for the device diagonal candidate D_i = M_ii + w K_ii.
 * The builder is intentionally pure and allocation-only; applying this
 * vector on device remains a separate qualified step. */
bool build_gpu_relaxation_diagonal(
    const std::vector<double> &mass_diagonal,
    const std::vector<double> &exchange_diagonal,
    double exchange_weight,
    const std::vector<uint8_t> &free_node_mask,
    std::vector<double> &diagonal,
    std::string &error);

} // namespace fullmag::fem

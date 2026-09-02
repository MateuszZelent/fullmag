#include "gpu/cuda/relaxation/gpu_relaxation_preconditioner.hpp"

#include <cmath>

namespace fullmag::fem {

const char *gpu_relaxation_preconditioner_kind_id(
    GpuRelaxationPreconditionerKind kind) noexcept
{
    switch (kind) {
    case GpuRelaxationPreconditionerKind::None: return "none";
    case GpuRelaxationPreconditionerKind::Diagonal: return "diagonal";
    }
    return "unsupported";
}

bool resolve_gpu_relaxation_preconditioner(
    const GpuRelaxationPreconditionerRequest &request,
    GpuRelaxationPreconditionerDecision &decision,
    std::string &error)
{
    decision = {};
    if (request.profile_stale) {
        error = "GPU relaxation preconditioner profile is stale";
        return false;
    }
    if (request.requested_kind.empty() || request.requested_kind == "none") {
        decision.kind = GpuRelaxationPreconditionerKind::None;
        decision.qualified = true;
        error.clear();
        return true;
    }
    if (request.requested_kind != "diagonal") {
        error = "unsupported GPU relaxation preconditioner: " +
            request.requested_kind;
        return false;
    }
    if (!request.profile_qualified) {
        error = "GPU diagonal relaxation preconditioner is not qualified";
        return false;
    }
    decision.kind = GpuRelaxationPreconditionerKind::Diagonal;
    decision.qualified = true;
    error.clear();
    return true;
}

bool build_gpu_relaxation_diagonal(
    const std::vector<double> &mass_diagonal,
    const std::vector<double> &exchange_diagonal,
    double exchange_weight,
    const std::vector<uint8_t> &free_node_mask,
    std::vector<double> &diagonal,
    std::string &error)
{
    diagonal.clear();
    if (mass_diagonal.empty() || mass_diagonal.size() != exchange_diagonal.size() ||
        (!free_node_mask.empty() && free_node_mask.size() != mass_diagonal.size()) ||
        !std::isfinite(exchange_weight) || exchange_weight < 0.0) {
        error = "GPU relaxation diagonal inputs have invalid dimensions or weight";
        return false;
    }
    diagonal.resize(mass_diagonal.size(), 0.0);
    for (size_t i = 0; i < mass_diagonal.size(); ++i) {
        const bool free = free_node_mask.empty() || free_node_mask[i] != 0u;
        if (!std::isfinite(mass_diagonal[i]) ||
            !std::isfinite(exchange_diagonal[i])) {
            error = "GPU relaxation diagonal inputs contain non-finite values";
            diagonal.clear();
            return false;
        }
        if (!free) {
            continue;
        }
        const double value = mass_diagonal[i] + exchange_weight * exchange_diagonal[i];
        if (!std::isfinite(value) || value <= 0.0) {
            error = "GPU relaxation diagonal is non-positive on a free node";
            diagonal.clear();
            return false;
        }
        diagonal[i] = value;
    }
    error.clear();
    return true;
}

} // namespace fullmag::fem

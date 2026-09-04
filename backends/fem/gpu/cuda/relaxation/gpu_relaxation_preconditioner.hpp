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
 * existing unpreconditioned baseline; an unqualified/stale profile
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

/* Reusable diagonal preconditioner for GPU relaxation.  Setup uploads the
 * pointwise factor M_i / (M_i + w K_ii); w already contains the canonical
 * exchange-Hessian scaling supplied by the call site. */
class GpuDiagonalRelaxationPreconditioner {
public:
    GpuDiagonalRelaxationPreconditioner() = default;
    ~GpuDiagonalRelaxationPreconditioner();

    GpuDiagonalRelaxationPreconditioner(
        const GpuDiagonalRelaxationPreconditioner &) = delete;
    GpuDiagonalRelaxationPreconditioner &operator=(
        const GpuDiagonalRelaxationPreconditioner &) = delete;

    bool setup(
        const std::vector<double> &mass_diagonal,
        const std::vector<double> &exchange_diagonal,
        double weight,
        void *stream,
        std::string &error);

    bool apply_host(
        const std::vector<double> &rhs,
        std::vector<double> &solution,
        std::string &error);

    bool apply_device(
        const double *d_rhs,
        double *d_solution,
        size_t n,
        void *stream,
        std::string &error);

    bool apply_device_component(
        const double *d_rhs_x,
        const double *d_rhs_y,
        const double *d_rhs_z,
        double *d_sol_x,
        double *d_sol_y,
        double *d_sol_z,
        size_t n,
        void *stream,
        std::string &error);

    bool is_active() const noexcept { return d_op_diag_inv_ != nullptr; }
    const double *device_factors() const noexcept { return d_op_diag_inv_; }

    uint64_t setup_count() const noexcept { return setup_count_; }
    uint64_t apply_count() const noexcept { return apply_count_; }

    void reset();

private:
    uint64_t setup_count_ = 0;
    uint64_t apply_count_ = 0;
    double cached_weight_ = 0.0;
    std::vector<double> cached_mass_;
    std::vector<double> cached_exchange_;
    std::vector<double> cached_op_diag_;
    double *d_op_diag_inv_ = nullptr;
    size_t configured_size_ = 0;
    size_t d_capacity_ = 0;
};

} // namespace fullmag::fem

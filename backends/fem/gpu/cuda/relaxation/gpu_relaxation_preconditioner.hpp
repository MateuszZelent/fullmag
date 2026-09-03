#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

enum class GpuRelaxationPreconditionerKind {
    None,
    Diagonal,
    ExchangeMass,
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

/* Reusable exchange-mass preconditioner for GPU relaxation: (M + w K)^{-1} M.
 * Setup runs once per (mesh_version, weight), preserving device buffers across
 * iterations. Hot apply does not allocate and does not perform D2H. */
class GpuExchangeMassPreconditioner {
public:
    GpuExchangeMassPreconditioner() = default;
    ~GpuExchangeMassPreconditioner();

    GpuExchangeMassPreconditioner(const GpuExchangeMassPreconditioner &) = delete;
    GpuExchangeMassPreconditioner &operator=(const GpuExchangeMassPreconditioner &) = delete;

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
    size_t d_capacity_ = 0;
};

} // namespace fullmag::fem

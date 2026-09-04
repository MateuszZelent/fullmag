#pragma once

#include "gpu/cuda/sparse/sparse_apply_plan.hpp"

#include <cstddef>
#include <cstdint>
#include <string>

namespace fullmag::fem {

enum class GpuExchangeMassCgVariant : std::uint8_t {
    Cg4,
    Cg8,
};

struct GpuExchangeMassSetupIdentity {
    std::uint64_t operator_revision = 0;
    std::uint64_t mass_revision = 0;
    std::uint64_t mask_revision = 0;

    bool operator==(const GpuExchangeMassSetupIdentity &other) const noexcept
    {
        return operator_revision == other.operator_revision &&
            mass_revision == other.mass_revision &&
            mask_revision == other.mask_revision;
    }
};

/* Fixed-iteration device CG for [M + w K_A] z = M g.
 *
 * The sparse plan, mass vector, and active mask are borrowed for the lifetime
 * of one setup identity.  The caller owns them and must use the setup stream
 * for every apply.  All Krylov storage and diagnostics are persistent device
 * allocations owned here; apply only enqueues a fixed CG4/CG8 schedule. */
class GpuExchangeMassPreconditioner {
public:
    explicit GpuExchangeMassPreconditioner(GpuExchangeMassCgVariant variant) noexcept;
    ~GpuExchangeMassPreconditioner();

    GpuExchangeMassPreconditioner(const GpuExchangeMassPreconditioner &) = delete;
    GpuExchangeMassPreconditioner &operator=(
        const GpuExchangeMassPreconditioner &) = delete;

    bool setup(
        SparseApplyPlan &sparse_plan,
        const double *d_mass_ms,
        const std::uint8_t *d_active_mask,
        std::size_t n,
        GpuExchangeMassSetupIdentity identity,
        void *stream,
        std::string &error);

    bool apply_device_xyz(
        const double *d_gradient_x,
        const double *d_gradient_y,
        const double *d_gradient_z,
        double *d_solution_x,
        double *d_solution_y,
        double *d_solution_z,
        std::size_t n,
        double exchange_weight,
        void *stream,
        std::string &error);

    void reset() noexcept;

    bool is_active() const noexcept { return sparse_plan_ != nullptr; }
    std::uint32_t fixed_iterations() const noexcept;
    std::uint64_t setup_count() const noexcept { return setup_count_; }
    std::uint64_t setup_reuse_count() const noexcept { return setup_reuse_count_; }
    std::uint64_t apply_count() const noexcept { return apply_count_; }
    SparseApplyPlan *borrowed_sparse_plan() const noexcept { return sparse_plan_; }
    const char *selected_sparse_variant() const noexcept;

    const double *device_final_residual_squared() const noexcept { return d_scalars_; }
    const std::uint32_t *device_iteration_count() const noexcept { return d_iterations_; }
    const std::uint32_t *device_failure_latch() const noexcept { return d_failure_latch_; }
    const double *device_workspace_for_diagnostics() const noexcept { return d_workspace_; }
    std::size_t device_workspace_component_stride() const noexcept { return workspace_stride_; }
    std::size_t device_workspace_value_count() const noexcept { return workspace_stride_ * 15u; }

private:
    bool allocate_workspace(std::size_t n, void *stream, std::string &error);

    GpuExchangeMassCgVariant variant_;
    SparseApplyPlan *sparse_plan_ = nullptr;
    const double *d_mass_ms_ = nullptr;
    const std::uint8_t *d_active_mask_ = nullptr;
    void *stream_ = nullptr;
    GpuExchangeMassSetupIdentity identity_{};
    std::size_t configured_size_ = 0;
    std::size_t capacity_ = 0;
    std::size_t workspace_stride_ = 0;
    std::uint64_t sparse_plan_generation_ = 0;

    double *d_workspace_ = nullptr;
    double *d_scalars_ = nullptr;
    std::uint32_t *d_iterations_ = nullptr;
    std::uint32_t *d_failure_latch_ = nullptr;
    void *d_reduction_storage_ = nullptr;
    std::size_t reduction_storage_bytes_ = 0;

    std::uint64_t setup_count_ = 0;
    std::uint64_t setup_reuse_count_ = 0;
    std::uint64_t apply_count_ = 0;
};

} // namespace fullmag::fem

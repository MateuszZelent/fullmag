#pragma once

/*
 * Device-resident CSR apply planning for FEM GPU operators.
 *
 * Setup owns CSR metadata, cuSPARSE descriptors, bounded benchmark scratch,
 * and the selected implementation.  apply_xyz only enqueues work on the
 * caller-provided stream; it never allocates, copies CSR metadata, or falls
 * back to a CPU implementation.
 */

#include <cstdint>
#include <string>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime_api.h>
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_CUDA_RUNTIME
using FullmagSparseApplyStream = cudaStream_t;
#else
using FullmagSparseApplyStream = void *;
#endif

enum class SparseApplyVariant : std::uint8_t {
    ScalarRow = 0,
    Subwarp = 1,
    Warp = 2,
    CusparseSpmv = 3,
    CusparseSpmm3 = 4,
};

const char *sparse_apply_variant_name(SparseApplyVariant variant) noexcept;
std::uint32_t sparse_apply_variant_id(SparseApplyVariant variant) noexcept;

struct SparseApplyCsrDeviceView {
    const std::uint32_t *row_offsets = nullptr;
    const std::uint32_t *col_indices = nullptr;
    const double *values = nullptr;
    std::uint32_t rows = 0;
    std::uint32_t cols = 0;
};

struct SparseApplyXyzDeviceView {
    const double *x = nullptr;
    const double *y = nullptr;
    const double *z = nullptr;
    double *out_x = nullptr;
    double *out_y = nullptr;
    double *out_z = nullptr;
    const std::uint8_t *active_mask = nullptr;
};

/*
 * Apply one CSR operator to three independent device-resident vectors.
 * The three RHS/output arrays use SoA layout.  CusparseSpmm3 uses a private,
 * persistent column-major scratch buffer to present those arrays as one
 * three-column dense matrix without changing the public layout.
 */
class SparseApplyPlan {
public:
    SparseApplyPlan() noexcept;
    ~SparseApplyPlan();

    SparseApplyPlan(const SparseApplyPlan &) = delete;
    SparseApplyPlan &operator=(const SparseApplyPlan &) = delete;
    SparseApplyPlan(SparseApplyPlan &&other) noexcept;
    SparseApplyPlan &operator=(SparseApplyPlan &&other) noexcept;

    void reset() noexcept;

    bool setup(
        const SparseApplyCsrDeviceView &csr,
        FullmagSparseApplyStream stream,
        std::string &error,
        bool allow_cusparse = true);

    bool apply_xyz(
        const SparseApplyXyzDeviceView &vectors,
        FullmagSparseApplyStream stream,
        std::string &error);

    bool force_variant_for_test(SparseApplyVariant variant, std::string &error);

    SparseApplyVariant selected_variant() const noexcept;
    const char *selected_variant_name() const noexcept;
    std::uint32_t selected_variant_id() const noexcept;
    const char *selection_provenance() const noexcept;

    std::uint64_t setup_count() const noexcept;
    std::uint64_t apply_count() const noexcept;
    std::uint64_t configuration_generation() const noexcept;
    bool is_configured() const noexcept;
    std::uint32_t configured_rows() const noexcept;
    std::uint32_t configured_cols() const noexcept;

private:
    struct Impl;
    Impl *impl_ = nullptr;
};

#if FULLMAG_HAS_CUDA_RUNTIME
namespace sparse_apply_detail {

/* Specialized low-level launches used by existing demag/exchange wrappers.
 * They intentionally expose only custom CUDA variants: cuSPARSE descriptors
 * belong to SparseApplyPlan setup and must not be recreated by hot-loop
 * compatibility wrappers. */
bool launch_scalar_csr(
    const std::uint32_t *row_offsets,
    const std::uint32_t *col_indices,
    const double *values,
    const double *input,
    double *output,
    int rows,
    SparseApplyVariant variant,
    cudaStream_t stream,
    const std::uint8_t *active_mask = nullptr);

bool launch_xyz_csr(
    const std::uint32_t *row_offsets,
    const std::uint32_t *col_indices,
    const double *values,
    const double *x,
    const double *y,
    const double *z,
    double *out_x,
    double *out_y,
    double *out_z,
    int rows,
    SparseApplyVariant variant,
    cudaStream_t stream,
    const std::uint8_t *active_mask = nullptr);

bool launch_three_csr(
    const std::uint32_t *row_offsets,
    const std::uint32_t *col_indices,
    const double *values_x,
    const double *values_y,
    const double *values_z,
    const double *input,
    double *out_x,
    double *out_y,
    double *out_z,
    int rows,
    SparseApplyVariant variant,
    cudaStream_t stream,
    const std::uint8_t *active_mask = nullptr);

bool launch_rhs_csr(
    const std::uint32_t *row_offsets,
    const std::uint32_t *col_indices,
    const double *values_x,
    const double *values_y,
    const double *values_z,
    const double *x,
    const double *y,
    const double *z,
    double *output,
    int rows,
    SparseApplyVariant variant,
    cudaStream_t stream);

bool launch_pack_xyz(
    const double *x,
    const double *y,
    const double *z,
    double *packed,
    int rows,
    int component_stride,
    cudaStream_t stream);

bool launch_unpack_xyz(
    const double *packed,
    double *x,
    double *y,
    double *z,
    int rows,
    int component_stride,
    cudaStream_t stream,
    const std::uint8_t *active_mask = nullptr);

bool launch_mask_xyz(
    double *x,
    double *y,
    double *z,
    int rows,
    cudaStream_t stream,
    const std::uint8_t *active_mask);

} // namespace sparse_apply_detail
#endif

} // namespace fullmag::fem

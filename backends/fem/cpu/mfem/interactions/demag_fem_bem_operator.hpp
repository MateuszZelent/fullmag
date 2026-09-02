#pragma once

#include "cpu/mfem/interactions/demag_fem_bem_surface.hpp"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Dense reference BEM operator for the Fredkin-Koehler open-boundary demag path.
 *
 * This operator owns only the boundary integral matrix for mapping the Neumann
 * potential trace u1 on the body boundary to Dirichlet correction values u2.
 * It uses an intentionally O(Nb^2) dense matrix as a correctness/reference
 * implementation. It remains the qualified CPU default until the diagnostic
 * ACA H-matrix path has explicit dense A/B parity evidence.
 * It does not extract boundary surfaces, solve sparse systems, transfer boundary values, compute energy, or manage workspace.
 */
class DenseDemagBemOperator {
public:
    static constexpr uint32_t kDefaultDenseReferenceMaxBoundaryNodes = 4096u;

    explicit DenseDemagBemOperator(
        uint32_t max_boundary_nodes = kDefaultDenseReferenceMaxBoundaryNodes)
        : max_boundary_nodes_(max_boundary_nodes) {}

    /*
     * Assemble the dense boundary integral matrix for an extracted surface.
     *
     * The current kernel uses linear-triangle Lindholm-style weights and a
     * constant-potential sanity correction on boundary vertices.
     */
    bool build(
        const Context &ctx,
        const DemagBoundarySurface &surface,
        std::string &error);

    /*
     * Apply the dense BEM boundary operator to boundary potential values.
     */
    bool apply(
        const std::vector<double> &u1_boundary,
        std::vector<double> &u2_boundary,
        std::string &error) const;

    const std::vector<double> &matrix_row_major() const { return matrix_; }
    uint32_t size() const { return size_; }
    uint32_t max_boundary_nodes() const { return max_boundary_nodes_; }
    const char *mode() const { return "dense_reference"; }

private:
    uint32_t size_ = 0;
    uint32_t max_boundary_nodes_ = kDefaultDenseReferenceMaxBoundaryNodes;
    std::vector<double> matrix_;
};

/*
 * Bounded diagnostic ACA H-matrix Fredkin-Koehler BEM operator.
 *
 * The cluster tree and admissible blocks are deterministic. Near blocks keep
 * exact Lindholm entries; admissible blocks keep deterministic ACA factors.
 * The operator never materializes the global boundary matrix and never falls
 * back to the dense reference implementation.
 */
struct AcaHMatrixDemagBemOptions {
    static constexpr double kDefaultAdmissibilityEta = 1.0;
    static constexpr uint32_t kDefaultLeafSize = 32u;
    static constexpr uint32_t kDefaultMaxRank = 32u;
    static constexpr double kDefaultRelativeTolerance = 1.0e-6;
    static constexpr uint64_t kDefaultMaxMemoryBytes = 2ull * 1024ull * 1024ull * 1024ull;
    static constexpr uint64_t kDefaultMaxExactEntries = 8ull * 1024ull * 1024ull;
    static constexpr uint32_t kDefaultMaxBlocks = 1'000'000u;

    double admissibility_eta = kDefaultAdmissibilityEta;
    uint32_t leaf_size = kDefaultLeafSize;
    uint32_t max_rank = kDefaultMaxRank;
    double relative_tolerance = kDefaultRelativeTolerance;
    uint64_t max_memory_bytes = kDefaultMaxMemoryBytes;
    uint64_t max_exact_entries = kDefaultMaxExactEntries;
    uint32_t max_blocks = kDefaultMaxBlocks;
};

struct AcaHMatrixDemagBemFarBlock {
    uint32_t source_begin = 0;
    uint32_t source_end = 0;
    uint32_t target_begin = 0;
    uint32_t target_end = 0;
    uint32_t rank = 0;
    uint64_t u_offset = 0;
    uint64_t v_offset = 0;
};

/* Flat, immutable view used by the CUDA owner for one device upload. */
struct AcaHMatrixDemagBemDeviceData {
    std::vector<uint32_t> boundary_permutation;
    std::vector<uint32_t> near_row_offsets;
    std::vector<uint32_t> near_column_indices;
    std::vector<double> near_values;
    std::vector<AcaHMatrixDemagBemFarBlock> far_blocks;
    std::vector<double> far_u;
    std::vector<double> far_v;
};

class AcaHMatrixDemagBemOperator {
public:
    AcaHMatrixDemagBemOperator();
    ~AcaHMatrixDemagBemOperator();

    AcaHMatrixDemagBemOperator(const AcaHMatrixDemagBemOperator &) = delete;
    AcaHMatrixDemagBemOperator &operator=(const AcaHMatrixDemagBemOperator &) = delete;
    AcaHMatrixDemagBemOperator(AcaHMatrixDemagBemOperator &&) noexcept;
    AcaHMatrixDemagBemOperator &operator=(AcaHMatrixDemagBemOperator &&) noexcept;

    bool build(
        const Context &ctx,
        const DemagBoundarySurface &surface,
        const AcaHMatrixDemagBemOptions &options,
        std::string &error);

    bool apply(
        const std::vector<double> &u1_boundary,
        std::vector<double> &u2_boundary,
        std::string &error) const;

    uint32_t size() const;
    uint32_t near_block_count() const;
    uint32_t far_block_count() const;
    uint64_t near_entry_count() const;
    uint64_t far_row_count() const;
    uint32_t max_rank_observed() const;
    double relative_error_estimate() const;
    uint64_t resident_bytes() const;
    const std::string &fingerprint() const;
    bool export_device_data(
        AcaHMatrixDemagBemDeviceData &data,
        std::string &error) const;
    const char *mode() const { return "hierarchical_aca_hmatrix"; }

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace fullmag::fem

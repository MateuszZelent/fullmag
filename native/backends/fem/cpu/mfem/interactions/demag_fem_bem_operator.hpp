#pragma once

#include "cpu/mfem/interactions/demag_fem_bem_surface.hpp"

#include <cstdint>
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
 * implementation. Production-scale compressed BEM/H2/FMM operators are future
 * implementations behind the same boundary-operator role.
 */
class DenseDemagBemOperator {
public:
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
    const char *mode() const { return "dense_reference"; }

private:
    uint32_t size_ = 0;
    std::vector<double> matrix_;
};

} // namespace fullmag::fem

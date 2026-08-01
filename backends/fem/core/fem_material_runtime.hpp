#pragma once

#include "core/fem_element_quadrature_material.hpp"

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Material-owned realization adapter for one imported P1 tetrahedral mesh.
 *
 * It binds ordered physical topology, active magnetic element ordinals, and
 * the independent Ms/A location-tagged values after plan validation.  It owns
 * no MFEM/CUDA state and is deliberately not a new Context-side loose map.
 */
class FemMaterialRuntimeAdapter {
public:
    explicit FemMaterialRuntimeAdapter(P1TetrahedralMaterialRealization realization);

    const P1TetrahedralMaterialRealization &realization() const noexcept;
    bool has_elementwise_ms() const noexcept;
    double ms_weighted_aos3_mass_bilinear(
        const std::vector<double> &left_aos3_nodal_values,
        const std::vector<double> &right_aos3_nodal_values) const;
    Aos3MassBilinearTermwiseResult ms_weighted_aos3_mass_bilinear_termwise(
        const std::vector<double> &left_aos3_nodal_values,
        const std::vector<double> &right_aos3_nodal_values) const;
    MsWeightedAos3AverageReduction ms_weighted_aos3_average_reduction(
        const std::vector<double> &aos3_nodal_values) const;

private:
    P1TetrahedralMaterialRealization realization_;
};

// Build the exact tetrahedral adapter for element-DG0 fields after validation.
// Uniform and nodal-P1 coefficients bypass it and are realized directly by MFEM.
bool initialize_material_runtime(Context &ctx, std::string &error);

} // namespace fullmag::fem

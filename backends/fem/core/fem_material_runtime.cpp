/* Material-runtime adapter source contract: topology/material realization only. */

#include "core/fem_material_runtime.hpp"

#include "context.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <utility>

namespace fullmag::fem {
namespace {

double tetrahedron_volume(const FemMeshRuntimeState &mesh, std::size_t element) {
    const auto coord = [&mesh](std::uint32_t node, std::size_t axis) {
        return mesh.nodes_xyz[static_cast<std::size_t>(node) * 3u + axis];
    };
    const std::size_t base = mesh.cell_offsets[element];
    const std::uint32_t n0 = mesh.cell_nodes[base + 0u];
    const std::uint32_t n1 = mesh.cell_nodes[base + 1u];
    const std::uint32_t n2 = mesh.cell_nodes[base + 2u];
    const std::uint32_t n3 = mesh.cell_nodes[base + 3u];
    const double ax = coord(n1, 0u) - coord(n0, 0u);
    const double ay = coord(n1, 1u) - coord(n0, 1u);
    const double az = coord(n1, 2u) - coord(n0, 2u);
    const double bx = coord(n2, 0u) - coord(n0, 0u);
    const double by = coord(n2, 1u) - coord(n0, 1u);
    const double bz = coord(n2, 2u) - coord(n0, 2u);
    const double cx = coord(n3, 0u) - coord(n0, 0u);
    const double cy = coord(n3, 1u) - coord(n0, 1u);
    const double cz = coord(n3, 2u) - coord(n0, 2u);
    return std::abs(ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) +
                    az * (bx * cy - by * cx)) / 6.0;
}

MaterialCoefficientValues material_values(
    const std::vector<double> &nodal,
    const std::vector<double> &element,
    double scalar)
{
    if (!element.empty()) {
        return {MaterialCoefficientLocation::element_dg0, element};
    }
    if (!nodal.empty()) {
        return {MaterialCoefficientLocation::nodal_p1, nodal};
    }
    return {MaterialCoefficientLocation::uniform, {scalar}};
}

} // namespace

FemMaterialRuntimeAdapter::FemMaterialRuntimeAdapter(P1TetrahedralMaterialRealization realization)
    : realization_(std::move(realization)) {}

const P1TetrahedralMaterialRealization &FemMaterialRuntimeAdapter::realization() const noexcept {
    return realization_;
}

bool FemMaterialRuntimeAdapter::has_elementwise_ms() const noexcept {
    return realization_.ms_location() == MaterialCoefficientLocation::element_dg0;
}

double FemMaterialRuntimeAdapter::ms_weighted_aos3_mass_bilinear(
    const std::vector<double> &left_aos3_nodal_values,
    const std::vector<double> &right_aos3_nodal_values) const
{
    return realization_.ms_weighted_aos3_mass_bilinear(
        left_aos3_nodal_values, right_aos3_nodal_values);
}

Aos3MassBilinearTermwiseResult
FemMaterialRuntimeAdapter::ms_weighted_aos3_mass_bilinear_termwise(
    const std::vector<double> &left_aos3_nodal_values,
    const std::vector<double> &right_aos3_nodal_values) const
{
    return realization_.ms_weighted_aos3_mass_bilinear_termwise(
        left_aos3_nodal_values, right_aos3_nodal_values);
}

MsWeightedAos3AverageReduction
FemMaterialRuntimeAdapter::ms_weighted_aos3_average_reduction(
    const std::vector<double> &aos3_nodal_values) const
{
    return realization_.ms_weighted_aos3_average_reduction(aos3_nodal_values);
}

bool initialize_material_runtime(Context &ctx, std::string &error) {
    if (ctx.material_fields.runtime.has_value()) {
        return true;
    }
    if (ctx.mesh.cell_types.size() != static_cast<std::size_t>(ctx.mesh.n_elements) ||
        ctx.mesh.cell_offsets.size() != static_cast<std::size_t>(ctx.mesh.n_elements) + 1u ||
        ctx.mesh.cell_offsets.empty() || ctx.mesh.cell_offsets.front() != 0u ||
        ctx.mesh.cell_offsets.back() != ctx.mesh.cell_nodes.size() ||
        ctx.mesh.nodes_xyz.size() != static_cast<std::size_t>(ctx.mesh.n_nodes) * 3u ||
        ctx.mesh.magnetic_element_mask.size() != static_cast<std::size_t>(ctx.mesh.n_elements)) {
        error = "FEM material runtime requires imported ordered mesh topology and magnetic-element mask";
        return false;
    }

    const bool has_element_dg0 =
        !ctx.material_fields.Ms_element_field.empty() ||
        !ctx.material_fields.A_element_field.empty();
    if (!has_element_dg0) {
        // Uniform and nodal-P1 coefficients are realized directly as MFEM
        // GridFunctionCoefficient objects.  The exact tetrahedral adapter is
        // reserved for sharp element-DG0 coefficients.
        return true;
    }
    const bool all_tet4 = std::all_of(
        ctx.mesh.cell_types.begin(),
        ctx.mesh.cell_types.end(),
        [](std::uint32_t type) { return type == FULLMAG_FEM_CELL_TET4; });
    bool tetrahedral_csr = all_tet4;
    for (std::size_t element = 0; tetrahedral_csr && element < ctx.mesh.n_elements; ++element) {
        tetrahedral_csr =
            ctx.mesh.cell_offsets[element + 1u] - ctx.mesh.cell_offsets[element] == 4u;
    }
    if (!tetrahedral_csr) {
        std::string fields;
        if (!ctx.material_fields.Ms_element_field.empty()) {
            fields = "Ms_element_field";
        }
        if (!ctx.material_fields.A_element_field.empty()) {
            fields += fields.empty() ? "A_element_field" : " and A_element_field";
        }
        error = "FEM element-DG0 material coefficients (" + fields +
                ") are unsupported on non-tetrahedral topology; "
                "mixed P1 requires uniform or nodal-P1 material fields";
        return false;
    }

    try {
        std::vector<P1TetrahedronMaterialTopology> topology;
        std::vector<std::size_t> active;
        topology.reserve(ctx.mesh.n_elements);
        active.reserve(ctx.mesh.n_elements);
        for (std::size_t element = 0; element < ctx.mesh.n_elements; ++element) {
            const std::size_t base = ctx.mesh.cell_offsets[element];
            topology.push_back({{
                ctx.mesh.cell_nodes[base + 0u], ctx.mesh.cell_nodes[base + 1u],
                ctx.mesh.cell_nodes[base + 2u], ctx.mesh.cell_nodes[base + 3u]},
                tetrahedron_volume(ctx.mesh, element)});
            if (ctx.mesh.magnetic_element_mask[element] != 0u) {
                active.push_back(element);
            }
        }
        FemMaterialRuntimeAdapter adapter(P1TetrahedralMaterialRealization(
            ctx.mesh.n_nodes,
            std::move(topology),
            std::move(active),
            material_values(
                ctx.material_fields.Ms_field,
                ctx.material_fields.Ms_element_field,
                ctx.material_fields.material.saturation_magnetisation),
            material_values(
                ctx.material_fields.A_field,
                ctx.material_fields.A_element_field,
                ctx.material_fields.material.exchange_stiffness)));
        ctx.material_fields.runtime.emplace(std::move(adapter));
        return true;
    } catch (const std::exception &exception) {
        error = std::string("FEM material runtime construction failed: ") + exception.what();
        return false;
    }
}

} // namespace fullmag::fem

#include "cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <initializer_list>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <vector>

namespace {

using fullmag::fem::oersted::DirectTetraQuadrature;
using fullmag::fem::oersted::DirectTetraQuadratureOptions;

void require(bool condition, const char *message)
{
    if (!condition) throw std::runtime_error(message);
}

void direct_tetra_signed_current_and_budget_contract()
{
    auto mesh = mfem::Mesh::MakeCartesian3D(
        1, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    mfem::RT_FECollection collection(0, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    mfem::GridFunction current(&space);
    mfem::Vector vector(3);
    vector = 0.0;
    vector[0] = 4.0;
    mfem::VectorConstantCoefficient coefficient(vector);
    current.ProjectCoefficient(coefficient);

    const std::vector<std::array<double, 3>> targets{
        {2.0, 0.5, 0.5}, {2.0, 0.25, 0.75}};
    DirectTetraQuadratureOptions options;
    options.base_quadrature_order = 4;
    options.maximum_subdivision_depth = 3;
    options.relative_tolerance = 1.0e-5;
    options.absolute_tolerance_apm = 1.0e-10;
    const auto forward = DirectTetraQuadrature::EvaluateField(
        mesh, current, targets, options);
    require(forward.operator_version ==
            DirectTetraQuadrature::operator_version,
        "direct tetrahedral Oersted operator version is not frozen");
    require(forward.h_xyz_apm.size() == targets.size() * 3u &&
            forward.diagnostics.source_target_pairs ==
                static_cast<std::uint64_t>(mesh.GetNE()) * targets.size(),
        "direct tetrahedral Oersted result dimensions are wrong");
    require(forward.diagnostics.unconverged_pair_count == 0,
        "far direct tetrahedral Oersted pair did not converge");
    require(std::all_of(forward.h_xyz_apm.begin(), forward.h_xyz_apm.end(),
            [](double value) { return std::isfinite(value); }),
        "direct tetrahedral Oersted result contains a non-finite value");

    current *= -1.0;
    const auto reversed = DirectTetraQuadrature::EvaluateField(
        mesh, current, targets, options);
    for (std::size_t i = 0; i < forward.h_xyz_apm.size(); ++i) {
        require(std::abs(reversed.h_xyz_apm[i] + forward.h_xyz_apm[i]) <=
                1.0e-13 * std::max(1.0, std::abs(forward.h_xyz_apm[i])),
            "direct tetrahedral Oersted failed signed-current involution");
    }
    const auto repeat = DirectTetraQuadrature::EvaluateField(
        mesh, current, targets, options);
    require(repeat.h_xyz_apm == reversed.h_xyz_apm,
        "direct tetrahedral Oersted accumulation is not deterministic");

    options.maximum_source_target_pairs = 1;
    bool rejected = false;
    try {
        (void)DirectTetraQuadrature::EvaluateField(mesh, current, targets, options);
    } catch (const std::invalid_argument &) {
        rejected = true;
    }
    require(rejected,
        "direct tetrahedral Oersted did not reject an exceeded pair budget");
}

void direct_tetra_singular_target_contract()
{
    auto mesh = mfem::Mesh::MakeCartesian3D(
        1, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    mfem::RT_FECollection collection(0, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    mfem::GridFunction current(&space);
    mfem::Vector vector(3);
    vector = 0.0;
    vector[0] = 4.0;
    mfem::VectorConstantCoefficient coefficient(vector);
    current.ProjectCoefficient(coefficient);

    mfem::Array<int> vertices;
    mesh.GetElementVertices(0, vertices);
    require(vertices.Size() == 4,
        "singular-target fixture must start from a tetrahedron");
    std::array<std::array<double, 3>, 4> points{};
    for (int local = 0; local < 4; ++local) {
        const auto *coordinate = mesh.GetVertex(vertices[local]);
        points[local] = {coordinate[0], coordinate[1], coordinate[2]};
    }
    const auto average = [&](std::initializer_list<int> indices) {
        std::array<double, 3> result{0.0, 0.0, 0.0};
        for (const int index : indices) {
            for (int component = 0; component < 3; ++component) {
                result[component] += points[index][component];
            }
        }
        const double scale = 1.0 / static_cast<double>(indices.size());
        for (double &component : result) component *= scale;
        return result;
    };

    const std::vector<std::array<double, 3>> targets{
        average({0, 1, 2, 3}), // interior
        average({0, 1, 2}),    // face
        average({0, 1}),        // edge
    };
    DirectTetraQuadratureOptions options;
    options.base_quadrature_order = 8;
    options.maximum_subdivision_depth = 6;
    options.absolute_tolerance_apm = 1.0e-9;
    options.relative_tolerance = 1.0e-5;
    const auto result = DirectTetraQuadrature::EvaluateField(
        mesh, current, targets, options);
    require(result.diagnostics.unconverged_pair_count == 0,
        "singular-target Oersted quadrature did not converge");
    require(std::all_of(result.h_xyz_apm.begin(), result.h_xyz_apm.end(),
            [](double value) { return std::isfinite(value); }),
        "singular-target Oersted result contains a non-finite value");
    require(result.diagnostics.refined_pairs > 0,
        "singular-target Oersted did not exercise adaptive refinement");

    auto bounded = options;
    bounded.maximum_subdivision_depth = 0;
    bool rejected = false;
    try {
        (void)DirectTetraQuadrature::EvaluateField(
            mesh, current, {targets.front()}, bounded);
    } catch (const std::runtime_error &) {
        rejected = true;
    }
    require(rejected,
        "singular-target Oersted silently accepted an exhausted depth budget");

    auto convergence_options = options;
    convergence_options.maximum_subdivision_depth = 4;
    const auto coarse = DirectTetraQuadrature::EvaluateField(
        mesh, current, targets, convergence_options);
    for (std::size_t index = 0; index < result.h_xyz_apm.size(); ++index) {
        require(std::abs(coarse.h_xyz_apm[index] - result.h_xyz_apm[index]) <=
                5.0e-5 * std::max(1.0, std::abs(result.h_xyz_apm[index])),
            "singular-target Oersted failed independent depth convergence");
    }

    DirectTetraQuadratureOptions defaults;
    const auto default_result = DirectTetraQuadrature::EvaluateField(
        mesh, current, targets, defaults);
    require(default_result.diagnostics.unconverged_pair_count == 0,
        "default singular-target Oersted options did not converge");
}

void direct_tetra_consistent_h1_projection_contract()
{
    auto source_mesh = mfem::Mesh::MakeCartesian3D(
        1, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    auto target_mesh = mfem::Mesh::MakeCartesian3D(
        1, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    for (int vertex = 0; vertex < target_mesh.GetNV(); ++vertex) {
        target_mesh.GetVertex(vertex)[0] += 2.0;
    }
    mfem::RT_FECollection source_collection(0, 3);
    mfem::FiniteElementSpace source_space(&source_mesh, &source_collection);
    mfem::GridFunction current(&source_space);
    mfem::Vector vector(3);
    vector = 0.0;
    vector[0] = 4.0;
    mfem::VectorConstantCoefficient coefficient(vector);
    current.ProjectCoefficient(coefficient);

    mfem::H1_FECollection target_collection(1, 3);
    mfem::FiniteElementSpace target_space(
        &target_mesh, &target_collection, 3, mfem::Ordering::byVDIM);
    mfem::GridFunction projected(&target_space);
    projected = 0.0;
    DirectTetraQuadratureOptions options;
    options.base_quadrature_order = 4;
    options.maximum_subdivision_depth = 4;
    options.relative_tolerance = 1.0e-5;
    const auto diagnostics = DirectTetraQuadrature::ProjectField(
        current, projected, options);
    require(diagnostics.unconverged_pair_count == 0,
        "consistent H1 projection left unconverged source pairs");
    require(diagnostics.source_target_pairs > 0,
        "consistent H1 projection did not evaluate direct source pairs");
    require(std::all_of(projected.begin(), projected.end(),
            [](double value) { return std::isfinite(value); }),
        "consistent H1 projection produced a non-finite field");
}

std::array<double, 3> linear_current_field_at_resolution(
    int subdivisions,
    int quadrature_order,
    int maximum_subdivision_depth)
{
    auto mesh = mfem::Mesh::MakeCartesian3D(
        subdivisions, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    mfem::RT_FECollection collection(0, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    mfem::GridFunction current(&space);
    mfem::VectorFunctionCoefficient coefficient(3,
        [](const mfem::Vector &point, mfem::Vector &value) {
            value = 0.0;
            value[0] = 4.0 + 2.0 * point[0];
        });
    current.ProjectCoefficient(coefficient);

    DirectTetraQuadratureOptions options;
    options.base_quadrature_order = quadrature_order;
    options.maximum_subdivision_depth = maximum_subdivision_depth;
    options.relative_tolerance = 1.0e-8;
    options.absolute_tolerance_apm = 1.0e-11;
    const auto result = DirectTetraQuadrature::EvaluateField(
        mesh, current, {{2.5, 0.37, 0.61}}, options);
    require(result.diagnostics.unconverged_pair_count == 0,
        "linear-current h-refinement left unconverged source pairs");
    require(result.h_xyz_apm.size() == 3u,
        "linear-current h-refinement returned an invalid field length");
    return {result.h_xyz_apm[0], result.h_xyz_apm[1], result.h_xyz_apm[2]};
}

void direct_tetra_h_refinement_contract()
{
    const auto reference = linear_current_field_at_resolution(16, 8, 6);
    const auto coarse = linear_current_field_at_resolution(1, 8, 6);
    const auto medium = linear_current_field_at_resolution(2, 8, 6);
    const auto fine = linear_current_field_at_resolution(4, 8, 6);
    const auto distance = [](const std::array<double, 3> &lhs,
                             const std::array<double, 3> &rhs) {
        double squared = 0.0;
        for (int component = 0; component < 3; ++component) {
            const double delta = lhs[component] - rhs[component];
            squared += delta * delta;
        }
        return std::sqrt(squared);
    };
    const double coarse_error = distance(coarse, reference);
    const double medium_error = distance(medium, reference);
    const double fine_error = distance(fine, reference);
    require(std::isfinite(coarse_error) && std::isfinite(medium_error) &&
                std::isfinite(fine_error),
        "linear-current h-refinement produced a non-finite error");
    std::cerr << "OE-F1 h-refinement errors: coarse=" << coarse_error
              << " medium=" << medium_error << " fine=" << fine_error << '\n';
    require(fine_error < coarse_error,
        "direct tetrahedral OE-F1 failed h-refinement improvement");

    const auto low_order = linear_current_field_at_resolution(4, 3, 6);
    const auto high_order = linear_current_field_at_resolution(4, 8, 6);
    const double order_error = distance(low_order, high_order);
    require(order_error <= 1.0e-7 * std::max(1.0, distance(high_order,
        std::array<double, 3>{0.0, 0.0, 0.0})),
        "direct tetrahedral OE-F1 quadrature order changed the converged far field");
}

std::array<double, 3> fdm_midpoint_uniform_cube_field(int subdivisions)
{
    require(subdivisions > 0, "FDM midpoint benchmark requires a positive resolution");
    const double cell_size = 1.0 / static_cast<double>(subdivisions);
    const double volume = cell_size * cell_size * cell_size;
    const std::array<double, 3> target{2.5, 0.37, 0.61};
    const std::array<double, 3> current{4.0, 0.0, 0.0};
    std::array<double, 3> field{0.0, 0.0, 0.0};
    constexpr double pi = 3.141592653589793238462643383279502884;
    for (int z = 0; z < subdivisions; ++z) {
        for (int y = 0; y < subdivisions; ++y) {
            for (int x = 0; x < subdivisions; ++x) {
                const std::array<double, 3> center{
                    (static_cast<double>(x) + 0.5) * cell_size,
                    (static_cast<double>(y) + 0.5) * cell_size,
                    (static_cast<double>(z) + 0.5) * cell_size};
                const std::array<double, 3> displacement{
                    target[0] - center[0], target[1] - center[1],
                    target[2] - center[2]};
                const double radius_squared = displacement[0] * displacement[0] +
                    displacement[1] * displacement[1] +
                    displacement[2] * displacement[2];
                const double inverse_radius_cubed =
                    1.0 / (radius_squared * std::sqrt(radius_squared));
                const std::array<double, 3> cross{
                    current[1] * displacement[2] - current[2] * displacement[1],
                    current[2] * displacement[0] - current[0] * displacement[2],
                    current[0] * displacement[1] - current[1] * displacement[0]};
                for (int component = 0; component < 3; ++component) {
                    field[component] += volume * cross[component] *
                        inverse_radius_cubed / (4.0 * pi);
                }
            }
        }
    }
    return field;
}

std::array<double, 3> fem_direct_uniform_cube_field(int subdivisions)
{
    auto mesh = mfem::Mesh::MakeCartesian3D(
        subdivisions, subdivisions, subdivisions,
        mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    mfem::RT_FECollection collection(0, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    mfem::GridFunction current(&space);
    mfem::Vector vector(3);
    vector = 0.0;
    vector[0] = 4.0;
    mfem::VectorConstantCoefficient coefficient(vector);
    current.ProjectCoefficient(coefficient);
    DirectTetraQuadratureOptions options;
    options.base_quadrature_order = 8;
    options.maximum_subdivision_depth = 6;
    options.relative_tolerance = 1.0e-7;
    options.absolute_tolerance_apm = 1.0e-10;
    const auto result = DirectTetraQuadrature::EvaluateField(
        mesh, current, {{2.5, 0.37, 0.61}}, options);
    require(result.diagnostics.unconverged_pair_count == 0,
        "FEM/FDM common-limit benchmark left unconverged source pairs");
    require(result.h_xyz_apm.size() == 3u &&
            std::all_of(result.h_xyz_apm.begin(), result.h_xyz_apm.end(),
                [](double value) { return std::isfinite(value); }),
        "FEM/FDM common-limit benchmark returned a non-finite FEM field");
    return {result.h_xyz_apm[0], result.h_xyz_apm[1], result.h_xyz_apm[2]};
}

double field_distance(
    const std::array<double, 3> &left,
    const std::array<double, 3> &right)
{
    double squared = 0.0;
    for (int component = 0; component < 3; ++component) {
        const double delta = left[component] - right[component];
        squared += delta * delta;
    }
    return std::sqrt(squared);
}

void direct_tetra_fdm_midpoint_common_limit_contract()
{
    const auto fem_coarse = fem_direct_uniform_cube_field(1);
    const auto fem_medium = fem_direct_uniform_cube_field(2);
    const auto fem_fine = fem_direct_uniform_cube_field(4);
    const auto fem_oracle = fem_direct_uniform_cube_field(8);
    const auto fdm_coarse = fdm_midpoint_uniform_cube_field(1);
    const auto fdm_medium = fdm_midpoint_uniform_cube_field(2);
    const auto fdm_fine = fdm_midpoint_uniform_cube_field(4);
    const auto fdm_finest = fdm_midpoint_uniform_cube_field(8);

    const double fem_coarse_error = field_distance(fem_coarse, fem_oracle);
    const double fem_medium_error = field_distance(fem_medium, fem_oracle);
    const double fem_fine_error = field_distance(fem_fine, fem_oracle);
    const double fdm_coarse_error = field_distance(fdm_coarse, fem_oracle);
    const double fdm_medium_error = field_distance(fdm_medium, fem_oracle);
    const double fdm_fine_error = field_distance(fdm_fine, fem_oracle);
    const double fdm_finest_error = field_distance(fdm_finest, fem_oracle);
    const double cross_method_fine_error = field_distance(fem_fine, fdm_fine);
    const double cross_method_coarse_error = field_distance(fem_coarse, fdm_coarse);
    std::cerr << "FEM/FDM Oersted common-limit diagnostics: FEM coarse="
              << fem_coarse_error << " medium=" << fem_medium_error
              << " fine=" << fem_fine_error << "; FDM coarse="
              << fdm_coarse_error << " medium=" << fdm_medium_error
              << " fine=" << fdm_fine_error << " finest="
              << fdm_finest_error << "; cross coarse="
              << cross_method_coarse_error << " fine="
              << cross_method_fine_error << '\n';
    require(std::isfinite(fem_coarse_error) &&
            std::isfinite(fem_medium_error) && std::isfinite(fem_fine_error) &&
            std::isfinite(fdm_coarse_error) && std::isfinite(fdm_medium_error) &&
            std::isfinite(fdm_fine_error) && std::isfinite(fdm_finest_error),
        "FEM/FDM common-limit benchmark produced a non-finite error");
    require(fem_fine_error < fem_coarse_error &&
            fdm_fine_error < fdm_coarse_error,
        "FEM/FDM common-limit benchmark did not improve under h-refinement");
    require(cross_method_fine_error < cross_method_coarse_error,
        "FEM/FDM common-limit discrepancy did not decrease under h-refinement");
    require(field_distance(fdm_finest, fem_oracle) < fdm_coarse_error,
        "FDM midpoint finest field did not approach the FEM reference oracle");
}

} // namespace

int main()
{
    try {
        direct_tetra_signed_current_and_budget_contract();
        direct_tetra_singular_target_contract();
        direct_tetra_consistent_h1_projection_contract();
        direct_tetra_h_refinement_contract();
        direct_tetra_fdm_midpoint_common_limit_contract();
        std::cout << "fem direct tetrahedral Oersted contract: PASS\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "fem direct tetrahedral Oersted contract: FAIL: "
                  << error.what() << '\n';
        return 1;
    }
}

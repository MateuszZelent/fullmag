#include "cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp"

#include <mfem.hpp>

#include <array>
#include <cmath>
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

} // namespace

int main()
{
    try {
        direct_tetra_signed_current_and_budget_contract();
        std::cout << "fem direct tetrahedral Oersted contract: PASS\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "fem direct tetrahedral Oersted contract: FAIL: "
                  << error.what() << '\n';
        return 1;
    }
}

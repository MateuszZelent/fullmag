#include "frequency_domain/floquet_waveguide_cross_section.hpp"
#include "frequency_domain/floquet_waveguide_demag_k.hpp"

#include <cassert>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <vector>

using fullmag::fem::frequency_domain::FloquetWaveguideCrossSectionBlockResult;
using fullmag::fem::frequency_domain::FloquetWaveguideCrossSectionProblem;
using fullmag::fem::frequency_domain::FrequencyDomainStatus;
using fullmag::fem::frequency_domain::FloquetWaveguideDemagKDiagnostics;
using fullmag::fem::frequency_domain::FloquetWaveguideDemagKProblem;
using fullmag::fem::frequency_domain::assemble_floquet_waveguide_cross_section_blocks;
using fullmag::fem::frequency_domain::build_floquet_waveguide_demag_k_real_split;

namespace {

FloquetWaveguideCrossSectionProblem reference_problem()
{
    static const double nodes[] = {0.0, 0.0, 2.0, 0.0, 0.0, 1.0};
    static const std::uint32_t triangles[] = {0u, 1u, 2u};
    static const std::uint8_t magnetic[] = {1u};
    static const std::uint32_t magnetic_nodes[] = {0u, 1u, 2u};
    // e1 is in x; e2 is axial z so the explicit -i*k source is observable.
    static const double frames[] = {
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    };
    static const std::uint32_t robin_edges[] = {0u, 1u, 1u, 2u, 2u, 0u};
    FloquetWaveguideCrossSectionProblem problem{};
    problem.node_count = 3u;
    problem.triangle_count = 1u;
    problem.node_xy_m = nodes;
    problem.triangle_nodes = triangles;
    problem.magnetic_element_mask = magnetic;
    problem.magnetic_node_indices = magnetic_nodes;
    problem.magnetic_node_count = 3u;
    problem.tangent_frames_xyz = frames;
    problem.uniform_saturation_magnetization_a_per_m = 2.0;
    problem.robin_edges = robin_edges;
    problem.robin_edge_count = 3u;
    problem.robin_beta = 1.0;
    problem.normalization_length_m = 2.0;
    return problem;
}

void assembles_p1_blocks_and_per_length_diagnostics()
{
    const auto problem = reference_problem();
    FloquetWaveguideCrossSectionBlockResult result{};
    assert(assemble_floquet_waveguide_cross_section_blocks(problem, &result) ==
           FrequencyDomainStatus::ok);
    assert(result.scalar_dof_count == 3u);
    assert(result.q_dof_count == 6u);
    assert(result.k_perp_row_major.size() == 9u);
    assert(result.mass_row_major.size() == 9u);
    assert(result.a_phiq_perp_row_major.size() == 18u);
    assert(result.a_qphi_axial_row_major.size() == 18u);
    // Triangle area is 1 m^2 and normalization length is 2 m.
    assert(std::abs(result.cross_section_area_m2 - 0.5) < 1.0e-12);
    assert(std::abs(result.robin_boundary_length_m -
                    (2.0 + std::sqrt(5.0) + 1.0) / 2.0) < 1.0e-12);
    assert(std::abs(result.mass_row_major[0] - 1.0 / 12.0) < 1.0e-12);
    assert(std::abs(result.mass_row_major[1] - 1.0 / 24.0) < 1.0e-12);
    // q=(node 0, e2) receives -Ms * mass_matrix(N_0,N_0) / length = -1/6
    // (consistent P1 mass matrix diagonal entry area/6, not area/3 -- audit
    // finding H5).
    assert(std::abs(result.a_phiq_axial_row_major[1] + 1.0 / 6.0) < 1.0e-12);
    // A_qphi axial is qphi_feedback_scale (default 1.0) times the negative
    // transpose because of Hermitian conjugation.
    assert(std::abs(result.a_qphi_axial_row_major[3] - 1.0 / 6.0) < 1.0e-12);
    for (std::size_t index = 0; index < result.k_perp_row_major.size(); ++index) {
        assert(std::isfinite(result.k_perp_row_major[index]));
        assert(std::isfinite(result.mass_row_major[index]));
    }
}

void assembled_blocks_feed_the_waveguide_schur_provider()
{
    const auto assembled = [&]() {
        FloquetWaveguideCrossSectionBlockResult result{};
        assert(assemble_floquet_waveguide_cross_section_blocks(reference_problem(), &result) ==
               FrequencyDomainStatus::ok);
        return result;
    }();
    std::vector<double> output(12u * 12u, 0.0);
    FloquetWaveguideDemagKProblem problem{};
    problem.q_dof_count = assembled.q_dof_count;
    problem.phi_dof_count = assembled.scalar_dof_count;
    problem.k_perp_row_major = assembled.k_perp_row_major.data();
    problem.mass_row_major = assembled.mass_row_major.data();
    problem.a_qphi_perp_row_major = assembled.a_qphi_perp_row_major.data();
    problem.a_qphi_axial_row_major = assembled.a_qphi_axial_row_major.data();
    problem.a_phiq_perp_row_major = assembled.a_phiq_perp_row_major.data();
    problem.a_phiq_axial_row_major = assembled.a_phiq_axial_row_major.data();
    problem.k_rad_per_m = 3.0;
    FloquetWaveguideDemagKDiagnostics diagnostics{};
    assert(build_floquet_waveguide_demag_k_real_split(
               problem, output.data(), output.size(), &diagnostics) == FrequencyDomainStatus::ok);
    assert(diagnostics.max_pivot_abs > 0.0);
    assert(diagnostics.max_schur_abs > 0.0);
    assert(std::isfinite(diagnostics.max_hermitian_residual));
}

void malformed_cross_section_is_rejected()
{
    auto problem = reference_problem();
    const std::uint32_t missing_node[] = {0u, 1u};
    problem.magnetic_node_indices = missing_node;
    problem.magnetic_node_count = 2u;
    FloquetWaveguideCrossSectionBlockResult result{};
    assert(assemble_floquet_waveguide_cross_section_blocks(problem, &result) ==
           FrequencyDomainStatus::validation_error);
    assert(result.error_message[0] != '\0');
}

} // namespace

int main()
{
    assembles_p1_blocks_and_per_length_diagnostics();
    assembled_blocks_feed_the_waveguide_schur_provider();
    malformed_cross_section_is_rejected();
    std::cout << "floquet waveguide cross-section contract tests passed\n";
    return 0;
}

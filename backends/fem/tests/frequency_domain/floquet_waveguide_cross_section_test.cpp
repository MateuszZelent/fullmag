#include "frequency_domain/floquet_waveguide_cross_section.hpp"
#include "frequency_domain/floquet_waveguide_demag_k.hpp"

#include <cassert>
#include <cmath>
#include <complex>
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
    // e1 is in x; e2 is axial z so the descriptor -i*k block is observable.
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

FloquetWaveguideCrossSectionProblem nodal_ms_problem()
{
    auto problem = reference_problem();
    static const double nodal_ms[] = {1.5, 2.5, 4.0};
    problem.saturation_magnetization_a_per_m = nodal_ms;
    problem.saturation_magnetization_count = 3u;
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
    // A 2D section integral already is the per-axial-length weak form.
    // Changing the comparison extrusion length must not change its measure.
    assert(std::abs(result.cross_section_area_m2 - 1.0) < 1.0e-12);
    assert(std::abs(result.robin_boundary_length_m -
                    (2.0 + std::sqrt(5.0) + 1.0)) < 1.0e-12);
    assert(std::abs(result.mass_row_major[0] - 1.0 / 6.0) < 1.0e-12);
    assert(std::abs(result.mass_row_major[1] - 1.0 / 12.0) < 1.0e-12);
    // q=(node 0, e2) receives -Ms * mass_matrix(N_0,N_0) = -1/3
    // (consistent P1 mass matrix diagonal entry area/6, not area/3 -- audit
    // finding H5).
    assert(std::abs(result.a_phiq_axial_row_major[1] + 1.0 / 3.0) < 1.0e-12);
    // A_qphi axial is qphi_feedback_scale (default 1.0) times the negative
    // transpose because of Hermitian conjugation.
    assert(std::abs(result.a_qphi_axial_row_major[3] - 1.0 / 3.0) < 1.0e-12);
    for (std::size_t index = 0; index < result.k_perp_row_major.size(); ++index) {
        assert(std::isfinite(result.k_perp_row_major[index]));
        assert(std::isfinite(result.mass_row_major[index]));
    }
}

void cross_section_is_independent_of_axial_comparison_length()
{
    auto problem = reference_problem();
    problem.normalization_length_m = 1.0;
    FloquetWaveguideCrossSectionBlockResult baseline{};
    assert(assemble_floquet_waveguide_cross_section_blocks(problem, &baseline) ==
           FrequencyDomainStatus::ok);
    for (double length : {1.0e-9, 2.0, 1.0e6}) {
        problem.normalization_length_m = length;
        FloquetWaveguideCrossSectionBlockResult actual{};
        assert(assemble_floquet_waveguide_cross_section_blocks(problem, &actual) ==
               FrequencyDomainStatus::ok);
        assert(actual.normalization_length_m == length);
        assert(actual.cross_section_area_m2 == baseline.cross_section_area_m2);
        assert(actual.robin_boundary_length_m == baseline.robin_boundary_length_m);
        assert(actual.k_perp_row_major == baseline.k_perp_row_major);
        assert(actual.mass_row_major == baseline.mass_row_major);
        assert(actual.a_phiq_perp_row_major == baseline.a_phiq_perp_row_major);
        assert(actual.a_phiq_axial_row_major == baseline.a_phiq_axial_row_major);
        assert(actual.a_qphi_perp_row_major == baseline.a_qphi_perp_row_major);
        assert(actual.a_qphi_axial_row_major == baseline.a_qphi_axial_row_major);
    }
}

void mixed_source_matches_independent_weak_quadrature()
{
    using Complex = std::complex<double>;
    auto problem = reference_problem();
    const double c = 1.0 / std::sqrt(2.0);
    const double rotated_frames[] = {
        c, c, 0.0, 0.0, 0.0, 1.0,
        c, c, 0.0, 0.0, 0.0, 1.0,
        c, c, 0.0, 0.0, 0.0, 1.0,
    };
    problem.tangent_frames_xyz = rotated_frames;
    FloquetWaveguideCrossSectionBlockResult blocks{};
    assert(assemble_floquet_waveguide_cross_section_blocks(problem, &blocks) ==
           FrequencyDomainStatus::ok);
    const Complex q[] = {{1.0, .2}, {.4, -.8}, {-.7, .4}, {1.1, .5}, {.3, -.9}, {-.2, .6}};
    const double gradient_x[] = {-.5, .5, 0.0};
    const double gradient_y[] = {-1.0, 0.0, 1.0};
    const double barycentric[3][3] = {
        {2.0/3.0, 1.0/6.0, 1.0/6.0},
        {1.0/6.0, 2.0/3.0, 1.0/6.0},
        {1.0/6.0, 1.0/6.0, 2.0/3.0},
    };
    // Exact degree-two triangle quadrature of grad(conj(v))*M.
    // This includes both transverse and axial complex magnetization.
    for (double k : {-3.0, 0.0, 3.0}) {
        for (std::size_t row = 0; row < 3; ++row) {
            Complex expected{};
            for (const auto &bary : barycentric) {
                Complex mx{}, mz{};
                for (std::size_t node = 0; node < 3; ++node) {
                    mx += 2.0 * c * bary[node] * q[2 * node];
                    mz += 2.0 * bary[node] * q[2 * node + 1];
                }
                // Rotated e1 has identical x and y components.
                expected += ((gradient_x[row] + gradient_y[row]) * mx +
                             Complex{0.0, k} * bary[row] * mz) / 3.0;
            }
            Complex actual{};
            for (std::size_t column = 0; column < 6; ++column) {
                actual += Complex{blocks.a_phiq_perp_row_major[row * 6 + column],
                                  k * blocks.a_phiq_axial_row_major[row * 6 + column]} * q[column];
            }
            // Descriptor residual is P phi + A_phiq q = 0.
            assert(std::abs(actual + expected) < 1.0e-12);
        }
    }
}

void nodal_ms_matches_independent_degree_three_quadrature_for_signed_k()
{
    using Complex = std::complex<double>;
    auto problem = nodal_ms_problem();
    const double c = 1.0 / std::sqrt(2.0);
    const double rotated_frames[] = {
        c, c, 0.0, 0.0, 0.0, 1.0,
        c, c, 0.0, 0.0, 0.0, 1.0,
        c, c, 0.0, 0.0, 0.0, 1.0,
    };
    problem.tangent_frames_xyz = rotated_frames;
    FloquetWaveguideCrossSectionBlockResult blocks{};
    assert(assemble_floquet_waveguide_cross_section_blocks(problem, &blocks) ==
           FrequencyDomainStatus::ok);

    const Complex q[] = {{1.0, .2}, {.4, -.8}, {-.7, .4}, {1.1, .5}, {.3, -.9},
                         {-.2, .6}};
    const double nodal_ms[] = {1.5, 2.5, 4.0};
    const double gradient_x[] = {-.5, .5, 0.0};
    const double gradient_y[] = {-1.0, 0.0, 1.0};
    // Dunavant degree-three rule, written as barycentric coordinates.  The
    // negative centroid weight is intentional; the rule is exact for the
    // cubic Ms*N_test*N_source axial integrand.
    const double barycentric[4][3] = {
        {1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0},
        {0.6, 0.2, 0.2},
        {0.2, 0.6, 0.2},
        {0.2, 0.2, 0.6},
    };
    const double quadrature_weights[] = {-27.0 / 48.0, 25.0 / 48.0, 25.0 / 48.0,
                                         25.0 / 48.0};

    for (double k : {-3.0, 0.0, 3.0}) {
        for (std::size_t row = 0; row < 3; ++row) {
            Complex physical_source{};
            for (std::size_t point = 0; point < 4; ++point) {
                const auto &bary = barycentric[point];
                double ms = 0.0;
                Complex mx{};
                Complex my{};
                Complex mz{};
                for (std::size_t node = 0; node < 3; ++node) {
                    ms += bary[node] * nodal_ms[node];
                    mx += bary[node] * c * q[2u * node];
                    my += bary[node] * c * q[2u * node];
                    mz += bary[node] * q[2u * node + 1u];
                }
                physical_source += quadrature_weights[point] * ms *
                    (Complex{gradient_x[row], 0.0} * mx +
                     Complex{gradient_y[row], 0.0} * my +
                     Complex{0.0, k * bary[row]} * mz);
            }
            // The reference triangle has area one.  A_phiq is the negative
            // descriptor copy of the physical weak source.
            Complex descriptor_source{};
            for (std::size_t column = 0; column < 6; ++column) {
                descriptor_source +=
                    Complex{blocks.a_phiq_perp_row_major[row * 6 + column],
                            k * blocks.a_phiq_axial_row_major[row * 6 + column]} * q[column];
            }
            assert(std::abs(descriptor_source + physical_source) < 1.0e-12);
        }
    }
}

void uniform_nodal_ms_recovers_the_legacy_uniform_branch()
{
    auto uniform = reference_problem();
    auto nodal = reference_problem();
    static const double nodal_ms[] = {2.0, 2.0, 2.0};
    nodal.saturation_magnetization_a_per_m = nodal_ms;
    nodal.saturation_magnetization_count = 3u;
    FloquetWaveguideCrossSectionBlockResult uniform_blocks{};
    FloquetWaveguideCrossSectionBlockResult nodal_blocks{};
    assert(assemble_floquet_waveguide_cross_section_blocks(uniform, &uniform_blocks) ==
           FrequencyDomainStatus::ok);
    assert(assemble_floquet_waveguide_cross_section_blocks(nodal, &nodal_blocks) ==
           FrequencyDomainStatus::ok);
    const auto compare = [](const std::vector<double> &left,
                            const std::vector<double> &right) {
        assert(left.size() == right.size());
        for (std::size_t index = 0; index < left.size(); ++index) {
            assert(std::abs(left[index] - right[index]) < 1.0e-14);
        }
    };
    compare(uniform_blocks.a_phiq_perp_row_major, nodal_blocks.a_phiq_perp_row_major);
    compare(uniform_blocks.a_phiq_axial_row_major, nodal_blocks.a_phiq_axial_row_major);
    compare(uniform_blocks.a_qphi_perp_row_major, nodal_blocks.a_qphi_perp_row_major);
    compare(uniform_blocks.a_qphi_axial_row_major, nodal_blocks.a_qphi_axial_row_major);
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
    cross_section_is_independent_of_axial_comparison_length();
    mixed_source_matches_independent_weak_quadrature();
    nodal_ms_matches_independent_degree_three_quadrature_for_signed_k();
    uniform_nodal_ms_recovers_the_legacy_uniform_branch();
    assembled_blocks_feed_the_waveguide_schur_provider();
    malformed_cross_section_is_rejected();
    std::cout << "floquet waveguide cross-section contract tests passed\n";
    return 0;
}

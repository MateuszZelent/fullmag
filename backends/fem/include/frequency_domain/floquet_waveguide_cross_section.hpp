#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"

#include <cstdint>
#include <vector>

namespace fullmag::fem::frequency_domain {

/*
 * Bounded P1 reference assembler for the translationally invariant 2.5D
 * waveguide representation.  The mesh is a two-dimensional triangular
 * cross-section; all integrals are reported per unit length along the
 * propagation axis.  A finite `normalization_length_m` scales the supplied
 * cross-section integrals by its reciprocal, which makes an extrusion of
 * that length comparable with a per-length result without hiding the scale.
 *
 * The returned real blocks are consumed by
 * `build_floquet_waveguide_demag_k_real_split`:
 *
 *   P(k) = K_perp + k^2 M,
 *   A_phiq(k) = A_phiq_perp + i k A_phiq_axial,
 *   A_qphi(k) = A_phiq(k)^H.
 *
 * The axial source follows exp(-i k z): A_phiq_axial contains the explicit
 * minus sign for the -i k M_z source.  This module is deliberately bounded
 * and does not claim to be the managed MFEM production assembler; it is a
 * deterministic element-level owner for contract and convergence tests.
 */
struct FloquetWaveguideCrossSectionProblem {
    std::uint64_t node_count = 0;
    std::uint64_t triangle_count = 0;
    const double *node_xy_m = nullptr;              // 2 * node_count
    const std::uint32_t *triangle_nodes = nullptr;  // 3 * triangle_count
    const std::uint8_t *magnetic_element_mask = nullptr;

    // Compact magnetic-node order used by the two tangent DOFs per node.
    const std::uint32_t *magnetic_node_indices = nullptr;
    std::uint64_t magnetic_node_count = 0;

    // Per global node: e1[xyz], e2[xyz], i.e. 6 * node_count doubles.
    const double *tangent_frames_xyz = nullptr;
    const double *saturation_magnetization_a_per_m = nullptr;
    std::uint64_t saturation_magnetization_count = 0;
    double uniform_saturation_magnetization_a_per_m = 0.0;

    // Every supplied edge is Robin unless an optional marker is zero.
    const std::uint32_t *robin_edges = nullptr;  // 2 * robin_edge_count
    const std::uint8_t *robin_edge_marker = nullptr;
    std::uint64_t robin_edge_count = 0;
    double robin_beta = 0.0;

    // Cross-section matrices are divided by this positive length.
    double normalization_length_m = 1.0;
};

struct FloquetWaveguideCrossSectionBlockResult {
    std::uint64_t scalar_dof_count = 0;
    std::uint64_t q_dof_count = 0;
    std::vector<double> k_perp_row_major{};
    std::vector<double> mass_row_major{};
    std::vector<double> a_qphi_perp_row_major{};
    std::vector<double> a_qphi_axial_row_major{};
    std::vector<double> a_phiq_perp_row_major{};
    std::vector<double> a_phiq_axial_row_major{};
    double cross_section_area_m2 = 0.0;
    double robin_boundary_length_m = 0.0;
    double normalization_length_m = 0.0;
    char error_message[256]{};
};

FrequencyDomainStatus assemble_floquet_waveguide_cross_section_blocks(
    const FloquetWaveguideCrossSectionProblem &problem,
    FloquetWaveguideCrossSectionBlockResult *out_result) noexcept;

} // namespace fullmag::fem::frequency_domain

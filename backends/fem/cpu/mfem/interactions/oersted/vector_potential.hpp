#pragma once

#include "cpu/mfem/transport/conservative_current_view.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem::oersted {

/**
 * Bounded CPU/double reference policy for the OE-F2 exact-sequence solve.
 *
 * The input mesh is the complete finite airbox/conductor domain.  The
 * conservative RT0 current view must use that same mesh; zero current in an
 * airbox element is represented by the RT0 field itself, not by a nodal
 * interpolation.  The implementation deliberately rejects larger systems
 * until the managed AMS/iterative lane is qualified.
 */
struct VectorPotentialOptions {
    double mu0_si = 1.25663706212e-6;
    double relative_tolerance = 1.0e-10;
    int maximum_nd_dofs = 4096;
    int maximum_h1_dofs = 2048;
    std::string boundary_gauge_variant = "tangential_A_h1_0.v1";
};

struct VectorPotentialDiagnostics {
    int nd_dofs = 0;
    int h1_dofs = 0;
    int block_size = 0;
    int harmonic_count = 0;
    int essential_nd_dof_count = 0;
    int essential_h1_dof_count = 0;
    double first_block_residual = 0.0;
    double constraint_residual = 0.0;
    double weak_ampere_residual = 0.0;
    double compatible_divergence_residual = 0.0;
    double source_pairing_norm = 0.0;
    double nodal_projection_residual = 0.0;
};

struct VectorPotentialResult {
    std::vector<double> a_dofs_t_m;
    std::vector<double> gauge_dofs_apm;
    std::vector<double> compatible_b_dofs_t;
    std::vector<double> compatible_h_dofs_apm;
    // AoS-3 continuous H1 projection consumed by the nodal LLG runtime.
    std::vector<double> nodal_h_xyz_apm;
    VectorPotentialDiagnostics diagnostics;
    std::string operator_version;
    std::string source_view_identity_digest;
    std::string boundary_gauge_variant;
};

class VectorPotentialSolver {
public:
    static constexpr const char *operator_version =
        "fem_oersted_hcurl_h1_gauge.v1";

    /** Solve the baseline H_0(curl) x H^1_0 mixed formulation. */
    static VectorPotentialResult Evaluate(
        const fullmag::fem::transport::ConservativeCurrentView &source,
        const VectorPotentialOptions &options = {});
};

} // namespace fullmag::fem::oersted

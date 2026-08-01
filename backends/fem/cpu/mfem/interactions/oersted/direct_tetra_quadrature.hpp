#pragma once

#include "cpu/mfem/transport/conservative_current_view.hpp"

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace mfem {
class GridFunction;
class Mesh;
} // namespace mfem

namespace fullmag::fem::oersted {

/**
 * CPU/double direct Biot--Savart policy for an affine tetrahedral RT0 source.
 * The kernel returns H in A/m, so no mu0 is included here.
 */
struct DirectTetraQuadratureOptions {
    int base_quadrature_order = 4;
    int maximum_subdivision_depth = 5;
    double absolute_tolerance_apm = 1.0e-10;
    double relative_tolerance = 1.0e-8;
    std::uint64_t maximum_source_target_pairs = 1'000'000;
};

struct DirectTetraQuadratureDiagnostics {
    std::uint64_t source_target_pairs = 0;
    std::uint64_t refined_pairs = 0;
    std::uint64_t unconverged_pair_count = 0;
    double maximum_pair_error_apm = 0.0;
};

struct DirectTetraQuadratureResult {
    std::vector<double> h_xyz_apm;
    DirectTetraQuadratureDiagnostics diagnostics;
    std::string operator_version;
    std::string source_view_identity_digest;
};

class DirectTetraQuadrature {
public:
    static constexpr const char *operator_version =
        "fem_oersted_direct_tetra_quadrature.v1";

    static DirectTetraQuadratureResult Evaluate(
        const fullmag::fem::transport::ConservativeCurrentView &source,
        const std::vector<std::array<double, 3>> &target_points,
        const DirectTetraQuadratureOptions &options = {});

    static DirectTetraQuadratureResult EvaluateField(
        const mfem::Mesh &mesh,
        const mfem::GridFunction &rt0_field,
        const std::vector<std::array<double, 3>> &target_points,
        const DirectTetraQuadratureOptions &options = {});
};

} // namespace fullmag::fem::oersted

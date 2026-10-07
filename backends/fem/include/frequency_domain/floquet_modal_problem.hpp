#pragma once

#include "frequency_domain/tangent_frame.hpp"

#include <array>
#include <cstddef>

namespace fullmag::fem::frequency_domain {

inline constexpr std::size_t kDefaultFloquetWorkspaceBudgetBytes = 256u * 1024u * 1024u;

// Internal native contract, not a public ABI payload. Entries describe complete
// classes already admitted by the mesh/corner certificate. This local algebra
// additionally checks coverage, representative consistency and tangent transport;
// it does not replace geometric seam certification.
struct FloquetTangentClassEntry {
    std::size_t full_node = 0;
    std::size_t reduced_node = 0;
    std::size_t representative_node = 0;
    std::array<double, 3> translation_m{};
    // Proper Cartesian spin rotation from representative to member, row-major.
    std::array<double, 9> spin_rotation{1., 0., 0., 0., 1., 0., 0., 0., 1.};
};

struct FloquetTangentConstraintRequest {
    const TangentFrameNode *frames = nullptr;
    std::size_t full_node_count = 0;
    std::size_t reduced_node_count = 0;
    const FloquetTangentClassEntry *entries = nullptr;
    std::size_t entry_count = 0;
    std::array<double, 3> k_rad_per_m{};
    double frame_tolerance = 1.0e-8;
    // Internal resource budget, independently adjustable by the native solver.
    // Includes the constraint and temporary class-validation arrays, not mesh/A.
    std::size_t workspace_budget_bytes = kDefaultFloquetWorkspaceBudgetBytes;
};

} // namespace fullmag::fem::frequency_domain

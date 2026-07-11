#pragma once

#include "cpu/frequency_domain/mfem_dmi_operator.hpp"
#include "cpu/frequency_domain/mfem_exchange_operator.hpp"
#include "cpu/frequency_domain/mfem_operator_context.hpp"
#include "cpu/frequency_domain/mfem_tangent_space.hpp"
#include "cpu/frequency_domain/mfem_zeeman_operator.hpp"
#include "frequency_domain/anisotropy_operator.hpp"
#include "frequency_domain/operator_terms.hpp"

#include <cstdint>
#include <string>

namespace fullmag::fem::frequency_domain {

struct MfemLinearizedOperatorWorkspace {
    TangentOperatorLocalBlock *zeeman_blocks = nullptr;
    TangentOperatorLocalBlock *uniaxial_anisotropy_blocks = nullptr;
    double *exchange_tangent = nullptr;
    double *zeeman_tangent = nullptr;
    double *uniaxial_anisotropy_tangent = nullptr;
    double *effective_field_tangent = nullptr;
    TangentOperatorLocalBlock *dmi_blocks = nullptr;
    double *dmi_tangent = nullptr;
    const MfemDmiElementTangentData *dmi_elements = nullptr;
    std::uint64_t dmi_element_count = 0;
    const double *dmi_lumped_mass = nullptr;
    const double *dmi_ms_field = nullptr;
    double dmi_uniform_ms = 0.0;
    double *dmi_delta_xyz = nullptr;
    double *dmi_residual_xyz = nullptr;
    double *dmi_field_xyz = nullptr;
    const double *demag_tangent = nullptr;
};

struct MfemLinearizedOperatorDiagnostics {
    std::uint64_t node_count = 0;
    std::uint64_t tangent_dof_count = 0;
    std::uint64_t exchange_edge_count = 0;
    double gamma0 = 0.0;
    double alpha = 0.0;
    double max_abs_exchange_field = 0.0;
    double max_abs_zeeman_field = 0.0;
    double max_abs_uniaxial_anisotropy_field = 0.0;
    double max_abs_dmi_field = 0.0;
    double max_abs_demag_field = 0.0;
    double max_abs_effective_field = 0.0;
    double max_abs_stiffness_rhs = 0.0;
    double max_abs_mass_rhs = 0.0;
    char error_message[128] = "";
};

// Immutable, canonical description of every public MFEM input that can alter
// the magnetic L/B_alpha JVP.  Callback-only demag providers must provide a
// stable content signature through demag_provider_signature.
struct MfemLinearizedPencilDependency {
    MfemOperatorContextDescriptor descriptor{};
    MfemTangentSpaceLayout layout{};
    const TangentFrameNode *nodes = nullptr;
    const TangentOperatorEdgeBlock *exchange_edges = nullptr;
    std::uint64_t exchange_edge_count = 0;
    const double *h_ext_a_per_m = nullptr;
    std::uint64_t h_ext_value_count = 0;
    const double *uniaxial_anisotropy_axis = nullptr;
    std::uint64_t uniaxial_anisotropy_axis_value_count = 0;
    double uniaxial_anisotropy_field_a_per_m = 0.0;
    const double *alpha_per_node = nullptr;
    std::uint64_t alpha_value_count = 0;
    double gamma0 = 0.0;
    double alpha = 0.0;
    const MfemDmiElementTangentData *dmi_elements = nullptr;
    std::uint64_t dmi_element_count = 0;
    const double *dmi_lumped_mass = nullptr;
    std::uint64_t dmi_lumped_mass_value_count = 0;
    const double *dmi_ms_field = nullptr;
    std::uint64_t dmi_ms_field_value_count = 0;
    double dmi_uniform_ms = 0.0;
    const double *demag_tangent_matrix_row_major = nullptr;
    std::uint64_t demag_tangent_matrix_value_count = 0;
    const char *demag_provider_signature = nullptr;
    const std::uint64_t *static_periodic_node_pairs = nullptr;
    std::uint64_t static_periodic_node_pair_count = 0;
    bool periodic_airbox = false;
};

std::string mfem_linearized_pencil_dependency_digest(
    const MfemLinearizedPencilDependency &dependency);

FrequencyDomainStatus apply_mfem_linearized_cpu_operator(
    const MfemOperatorContextDescriptor &descriptor,
    const MfemTangentSpaceLayout &layout,
    const TangentFrameNode *nodes,
    const TangentOperatorEdgeBlock *exchange_edges,
    std::uint64_t exchange_edge_count,
    const double h_ext_a_per_m[3],
    const double uniaxial_anisotropy_axis[3],
    double uniaxial_anisotropy_field_a_per_m,
    const double *alpha_per_node,
    double gamma0,
    double alpha,
    const MfemLinearizedOperatorWorkspace &workspace,
    const double *tangent_in,
    double *out_stiffness_rhs_tangent,
    double *out_mass_tangent,
    MfemLinearizedOperatorDiagnostics *out_diagnostics) noexcept;

// Canonical dynamic-pencil action for the existing MFEM JVP.  The historical
// JVP publishes S and M in S q = lambda M q; the one physical pencil uses
// L=-S and B_alpha=-M so A(omega)=+i*omega*B_alpha-L.  Keep that sign bridge
// at this boundary so materialization and driven response cannot each invent
// a top-level harmonic equation.
FrequencyDomainStatus apply_mfem_linearized_cpu_pencil(
    const MfemOperatorContextDescriptor &descriptor,
    const MfemTangentSpaceLayout &layout,
    const TangentFrameNode *nodes,
    const TangentOperatorEdgeBlock *exchange_edges,
    std::uint64_t exchange_edge_count,
    const double h_ext_a_per_m[3],
    const double uniaxial_anisotropy_axis[3],
    double uniaxial_anisotropy_field_a_per_m,
    const double *alpha_per_node,
    double gamma0,
    double alpha,
    const MfemLinearizedOperatorWorkspace &workspace,
    const double *tangent_in,
    double *out_l_tangent,
    double *out_b_alpha_tangent,
    MfemLinearizedOperatorDiagnostics *out_diagnostics) noexcept;

} // namespace fullmag::fem::frequency_domain

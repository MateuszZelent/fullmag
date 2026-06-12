#pragma once

#include "cpu/frequency_domain/mfem_exchange_operator.hpp"
#include "cpu/frequency_domain/mfem_operator_context.hpp"
#include "cpu/frequency_domain/mfem_tangent_space.hpp"
#include "cpu/frequency_domain/mfem_zeeman_operator.hpp"
#include "frequency_domain/operator_terms.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

struct MfemLinearizedOperatorWorkspace {
    TangentOperatorLocalBlock *zeeman_blocks = nullptr;
    double *exchange_tangent = nullptr;
    double *zeeman_tangent = nullptr;
    double *effective_field_tangent = nullptr;
};

struct MfemLinearizedOperatorDiagnostics {
    std::uint64_t node_count = 0;
    std::uint64_t tangent_dof_count = 0;
    std::uint64_t exchange_edge_count = 0;
    double gamma0 = 0.0;
    double alpha = 0.0;
    double max_abs_exchange_field = 0.0;
    double max_abs_zeeman_field = 0.0;
    double max_abs_effective_field = 0.0;
    double max_abs_stiffness_rhs = 0.0;
    double max_abs_mass_rhs = 0.0;
    char error_message[128] = "";
};

FrequencyDomainStatus apply_mfem_linearized_cpu_operator(
    const MfemOperatorContextDescriptor &descriptor,
    const MfemTangentSpaceLayout &layout,
    const TangentFrameNode *nodes,
    const TangentOperatorEdgeBlock *exchange_edges,
    std::uint64_t exchange_edge_count,
    const double h_ext_a_per_m[3],
    double gamma0,
    double alpha,
    const MfemLinearizedOperatorWorkspace &workspace,
    const double *tangent_in,
    double *out_stiffness_rhs_tangent,
    double *out_mass_tangent,
    MfemLinearizedOperatorDiagnostics *out_diagnostics) noexcept;

} // namespace fullmag::fem::frequency_domain

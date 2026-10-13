#pragma once

#include "frequency_domain/floquet_modal_problem.hpp"

#include <complex>
#include <vector>

#ifndef FULLMAG_HAS_MFEM_STACK
#define FULLMAG_HAS_MFEM_STACK 0
#endif
#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem::frequency_domain {

// Full-field Bloch convention: q_member = exp(-i k.delta_r) T_member^T Q T_rep q_rep.
// Tangent components are interleaved: q[2*node + component]. Both actions have
// linear storage/cost and allocate nothing; input and output must not overlap.
class FloquetTangentProlongation {
public:
    FrequencyDomainStatus initialize(const FloquetTangentConstraintRequest &) noexcept;
    std::size_t full_dof_count() const noexcept { return 2 * entries_.size(); }
    std::size_t reduced_dof_count() const noexcept { return 2 * reduced_nodes_; }
    std::size_t storage_bytes() const noexcept;
    bool prolong(const std::complex<double> *, std::size_t,
                 std::complex<double> *, std::size_t) const noexcept;
    bool restrict_adjoint(const std::complex<double> *, std::size_t,
                          std::complex<double> *, std::size_t) const noexcept;

private:
    struct Entry {
        std::size_t reduced_node = 0;
        std::array<std::complex<double>, 4> tangent_map{};
    };
    std::vector<Entry> entries_{};
    std::size_t reduced_nodes_ = 0;
};

#if FULLMAG_HAS_MFEM_STACK
// Matrix-free C^H A C over an ordinary-gradient native MFEM magnetic operator.
// Never pass a shifted-derivative/envelope operator here. A and this wrapper
// share a lifetime; a separate wrapper/workspace is required for each concurrent
// solve. Initialization owns C and sizes its scratch buffers. The wrapper's
// arithmetic does not resize them; allocation/device behavior inside MFEM and
// the supplied operator still requires separate runtime instrumentation.
// Input/output use real-split storage [Re(q interleaved), Im(q interleaved)].
class FloquetReducedMagneticOperator final : public mfem::Operator {
public:
    FloquetReducedMagneticOperator(const mfem::Operator &ordinary_full_operator,
                                  const FloquetTangentProlongation &constraint,
                                  std::size_t workspace_budget_bytes = kDefaultFloquetWorkspaceBudgetBytes);
    void Mult(const mfem::Vector &, mfem::Vector &) const override;
    void MultTranspose(const mfem::Vector &, mfem::Vector &) const override;

private:
    void apply(const mfem::Vector &, mfem::Vector &, bool transpose) const;
    const mfem::Operator &full_operator_;
    FloquetTangentProlongation constraint_;
    mutable std::vector<std::complex<double>> reduced_, full_, applied_;
    mutable mfem::Vector full_real_, full_imag_, out_real_, out_imag_;
};
#endif

} // namespace fullmag::fem::frequency_domain

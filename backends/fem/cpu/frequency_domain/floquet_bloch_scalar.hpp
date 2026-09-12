#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"
#include "frequency_domain/tangent_frame.hpp"

#include <array>
#include <cstdint>
#include <memory>

#ifndef FULLMAG_HAS_MFEM_STACK
#define FULLMAG_HAS_MFEM_STACK 0
#endif

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem::frequency_domain {

#if FULLMAG_HAS_MFEM_STACK

// A Floquet scalar field has two mathematically distinct realizations.  The
// shifted envelope keeps the Bloch factor inside the weak derivative, while
// the full-field form keeps ordinary derivatives and applies the phase only
// through the separate constraint matrix.  They must not be mixed.
enum class FloquetBlochScalarRepresentation : std::uint32_t {
    shifted_envelope = 0,
    full_field_phase_constrained = 1,
};

struct FloquetBlochScalarAssemblyRequest {
    mfem::FiniteElementSpace *scalar_space = nullptr;
    std::array<double, 3> k_rad_per_m{};
    double robin_beta = 0.0;
    mfem::Array<int> *robin_boundary_marker = nullptr;
    FloquetBlochScalarRepresentation representation =
        FloquetBlochScalarRepresentation::shifted_envelope;
};

struct FloquetBlochScalarAssemblyResult {
    std::unique_ptr<mfem::SesquilinearForm> form{};
    std::unique_ptr<mfem::ComplexSparseMatrix> operator_matrix{};
};

struct FloquetBlochScalarConstraintEntry {
    std::uint64_t full_dof = 0;
    std::uint64_t reduced_dof = 0;
    std::array<double, 3> translation_m{};
};

struct FloquetBlochScalarConstraintRequest {
    mfem::FiniteElementSpace *scalar_space = nullptr;
    const FloquetBlochScalarConstraintEntry *entries = nullptr;
    std::uint64_t entry_count = 0;
    std::uint64_t reduced_dof_count = 0;
    std::array<double, 3> k_rad_per_m{};
};

struct FloquetBlochScalarConstraintResult {
    std::unique_ptr<mfem::ComplexSparseMatrix> constraint_matrix{};
};

struct FloquetBlochScalarReducedOperatorRequest {
    const mfem::ComplexOperator *full_operator = nullptr;
    const mfem::ComplexOperator *constraint = nullptr;
};

struct FloquetBlochScalarReducedOperatorResult {
    std::unique_ptr<mfem::DenseMatrix> matrix{};
};

struct FloquetBlochScalarTangentSourceRequest {
    mfem::FiniteElementSpace *scalar_space = nullptr;
    const TangentFrameNode *tangent_frames = nullptr;
    std::uint64_t tangent_frame_count = 0;
    double saturation_magnetization_a_per_m = 0.0;
    const double *saturation_magnetization_field = nullptr;
    std::uint64_t saturation_magnetization_field_count = 0;
    std::array<double, 3> k_rad_per_m{};
    FloquetBlochScalarRepresentation representation =
        FloquetBlochScalarRepresentation::shifted_envelope;
    const std::uint8_t *magnetic_element_mask = nullptr;
    std::uint64_t magnetic_element_mask_count = 0;
    const std::uint32_t *magnetic_reduced_node = nullptr;
    std::uint64_t magnetic_reduced_node_count = 0;
};

struct FloquetBlochScalarTangentSourceResult {
    std::unique_ptr<mfem::ComplexSparseMatrix> source_matrix{};
};

FrequencyDomainStatus assemble_floquet_bloch_scalar_operator(
    const FloquetBlochScalarAssemblyRequest &request,
    FloquetBlochScalarAssemblyResult *out_result) noexcept;

FrequencyDomainStatus assemble_floquet_bloch_scalar_constraint(
    const FloquetBlochScalarConstraintRequest &request,
    FloquetBlochScalarConstraintResult *out_result) noexcept;

FrequencyDomainStatus assemble_floquet_bloch_scalar_reduced_operator(
    const FloquetBlochScalarReducedOperatorRequest &request,
    FloquetBlochScalarReducedOperatorResult *out_result) noexcept;

FrequencyDomainStatus assemble_floquet_bloch_scalar_tangent_source(
    const FloquetBlochScalarTangentSourceRequest &request,
    FloquetBlochScalarTangentSourceResult *out_result) noexcept;

#endif

} // namespace fullmag::fem::frequency_domain

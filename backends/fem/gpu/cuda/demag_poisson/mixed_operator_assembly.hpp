#pragma once

/*
 * GPU CUDA Poisson demag mixed-operator assembly header (module-private).
 *
 * Declares the element-loop assembly of the strict GPU Poisson demag RHS,
 * magnetic-recovery, and visual-recovery CSR operators that operators.cpp
 * dispatches to, plus the small DOF and periodic-class helpers both sides
 * share. Two realizations exist:
 * - the default two-pass CSR assembly (mixed_operator_assembly_csr.cpp) for
 *   the nonperiodic path;
 * - the legacy std::map row assembly (mixed_operator_assembly_maps.cpp),
 *   which also owns the periodic node-class merge and serves the
 *   FULLMAG_FEM_DEMAG_OPERATOR_BUILD=maps A/B check.
 * For the nonperiodic path both produce byte-identical arrays. Validation,
 * the Robin boundary mass, essential DOFs, recovery modes, fingerprints,
 * upload, and destruction stay in operators.cpp.
 */

#include "context.hpp"
#include "fem_common.hpp"
#include "gpu/cuda/demag_poisson/operators.hpp"

#include <cstddef>
#include <cstdint>
#include <string>

namespace fullmag::fem::demag_operator_assembly {

inline int signed_dof_index(int dof)
{
    return dof >= 0 ? dof : -1 - dof;
}

inline double signed_dof_sign(int dof)
{
    return dof >= 0 ? 1.0 : -1.0;
}

inline double scalar_ms_value(const Context &ctx, uint32_t node)
{
    return scalar_field_value(
        ctx.material_fields.Ms_field,
        static_cast<size_t>(node),
        ctx.material_fields.material.saturation_magnetisation);
}

inline uint64_t periodic_scalar_row_count(const Context &ctx)
{
    return ctx.mesh.periodic_reduced_node.empty()
        ? ctx.mesh.n_nodes
        : ctx.mesh.periodic_reduced_node_count;
}

inline uint32_t periodic_scalar_column(const Context &ctx, uint32_t node)
{
    if (ctx.mesh.periodic_reduced_node.empty()) {
        return node;
    }
    return ctx.mesh.periodic_reduced_node[static_cast<size_t>(node)];
}

#if FULLMAG_HAS_MFEM_STACK
// Validated inputs from build_mixed_demag_operators_with_path().
struct MixedDemagAssemblyInput {
    const Context *ctx = nullptr;
    mfem::Mesh *mesh = nullptr;
    mfem::FiniteElementSpace *potential_fes = nullptr;
    mfem::FiniteElementSpace *state_fes = nullptr;
    bool periodic_node_class_reduction = false;
    int expected_potential_order = 0;
    uint64_t state_rows = 0;
    uint64_t potential_rows = 0;
    uint64_t rhs_rows = 0;
};

// Legacy assembly: one std::map per CSR row. Required for periodic node-class
// reduction; selectable for the nonperiodic path only as an A/B reference.
bool assemble_mixed_demag_operators_with_row_maps(
    const MixedDemagAssemblyInput &input,
    GpuDemagPoissonWorkspace &workspace,
    std::string &error);

// Default nonperiodic assembly: symbolic CSR patterns from element DOF
// incidence, then numeric accumulation into precomputed CSR positions in the
// row-map order (element, quadrature point, i, k). Rejects periodic input.
bool assemble_mixed_demag_operators_with_csr(
    const MixedDemagAssemblyInput &input,
    GpuDemagPoissonWorkspace &workspace,
    std::string &error);
#endif

} // namespace fullmag::fem::demag_operator_assembly

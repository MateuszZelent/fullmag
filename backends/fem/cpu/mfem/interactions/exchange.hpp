#pragma once

#include "cpu/mfem/interactions/exchange_fallback.hpp"
#include "cpu/mfem/interactions/exchange_field.hpp"
#include "cpu/mfem/interactions/exchange_legacy_gpu_upload.hpp"
#include "cpu/mfem/interactions/exchange_operator.hpp"
#include "cpu/mfem/interactions/exchange_runtime.hpp"
#include "fullmag_fem.h"

#include <cstdint>
#include <vector>

namespace mfem {
class BilinearForm;
class CGSolver;
class GSSmoother;
class SparseMatrix;
class Vector;
}

namespace fullmag::fem {

struct Context;

/*
 * MFEM runtime workspace for native FEM exchange.
 *
 * Owns the exchange/mass bilinear forms, reusable mass and operator vectors,
 * host component buffers for H_ex, the consistent-mass projection policy, and
 * the readiness flag published after a refresh. It does not own MFEM mesh,
 * finite-element spaces, magnetization GridFunctions, material coefficients,
 * demag state, or GPU exchange metadata.
 */
struct ExchangeMfemRuntimeState {
    bool use_consistent_mass = false;
    std::vector<double> h_x;
    std::vector<double> h_y;
    std::vector<double> h_z;
    std::vector<double> component_tmp;
    mfem::BilinearForm *exchange_form = nullptr;
    mfem::BilinearForm *mass_form = nullptr;
    mfem::Vector *mass_ones = nullptr;
    mfem::Vector *mass_lumped = nullptr;
    mfem::Vector *inv_lumped_mass = nullptr;
    mfem::Vector *tmp_vec = nullptr;
    mfem::Vector *out_vec = nullptr;
    mfem::SparseMatrix *consistent_mass_matrix = nullptr;
    mfem::GSSmoother *consistent_mass_preconditioner = nullptr;
    mfem::CGSolver *consistent_mass_solver = nullptr;
    mfem::SparseMatrix *periodic_mass_matrix = nullptr;
    mfem::GSSmoother *periodic_mass_preconditioner = nullptr;
    mfem::CGSolver *periodic_mass_solver = nullptr;
    mfem::Vector *periodic_mass_rhs = nullptr;
    mfem::Vector *periodic_mass_solution = nullptr;
    mfem::Vector *periodic_mass_residual = nullptr;
    uint64_t consistent_mass_solver_applies = 0;
    uint64_t periodic_mass_solver_applies = 0;
    uint64_t periodic_mass_setup_count = 0;
    bool ready = false;
};

/*
 * Runtime products emitted by the native FEM exchange modules.
 *
 * The exchange field buffer is stored in AOS-3 order as H_ex in A/m and is
 * consumed by effective-field composition, observable state I/O, snapshots,
 * and GPU runtime bootstrap. MFEM-specific exchange workspace is grouped
 * under mfem. The exchange enablement flag is stored here as plan-owned
 * runtime state so the compatibility Context does not own exchange plan fields
 * or operator internals directly.
 */
struct ExchangeRuntimeState {
    bool enabled = true;
    std::vector<double> h_xyz;
    ExchangeMfemRuntimeState mfem{};
};

/*
 * Initialize native FEM exchange plan fields.
 *
 * Copies the ABI plan's exchange enable flag and, when the MFEM stack is
 * active, the consistent-mass exchange projection policy into the Exchange
 * runtime state. Operator assembly, mass projection, field computation, and
 * runtime refresh remain in the dedicated Exchange modules included here.
 */
void initialize_exchange_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan);

/*
 * Aggregated include surface for native FEM exchange responsibilities.
 *
 * This compatibility umbrella owns plan-field import, runtime output storage,
 * and MFEM exchange workspace storage. It does not assemble operators, compute
 * H_ex, refresh runtime fields, handle fallback, project mass, or upload GPU
 * state. Those responsibilities stay in the dedicated owner modules:
 * exchange_operator.*, exchange_field.*, exchange_runtime.*,
 * exchange_fallback.*, exchange_mass_projection.*, and
 * exchange_legacy_gpu_upload.*.
 */

} // namespace fullmag::fem

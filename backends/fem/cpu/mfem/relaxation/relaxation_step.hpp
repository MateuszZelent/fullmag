#pragma once

#include "fullmag_fem.h"
#include "cpu/mfem/interactions/demag_poisson_runtime.hpp"
#include "cpu/mfem/interactions/operator_dependency.hpp"

#include <array>

#include <cstdint>
#include <string>
#include <vector>

namespace mfem {
class SparseMatrix;
}

namespace fullmag::fem {

struct Context;

struct AcceptedEnergyProof {
    bool available = false;
    double delta_j = 0.0;
    double roundoff_bound_j = 0.0;
    double delta_upper_j = 0.0;
    double armijo_rhs_j = 0.0;
};

// A bounded static PGBB guard keeps exact host snapshots. Vector capacity is
// retained across publications; no signature can hide a changed field/input.
struct FemCpuPgbbAcceptedGuard {
    bool valid = false;
    PoissonOperatorDependencyKey poisson_key{};
    OperatorDependencyKey exchange_key{};
    std::array<uint64_t, 32> scalars{};
    std::array<std::vector<double>, 9> fields;
    std::vector<uint8_t> magnetic_mask;
};

struct FemRelaxationRuntimeState {
    double step_size = 1.0e-6;
    bool use_bb1 = true;
    uint64_t reset_consecutive = 0;
    uint64_t accepted_steps = 0;
    AcceptedEnergyProof accepted_energy_proof;
    std::vector<double> nonlinear_cg_direction;
    mfem::SparseMatrix *exchange_mass_preconditioner = nullptr;
    const mfem::SparseMatrix *exchange_mass_preconditioner_mass = nullptr;
    const mfem::SparseMatrix *exchange_mass_preconditioner_exchange = nullptr;
    double exchange_mass_preconditioner_weight = 0.0;
    int exchange_mass_preconditioner_height = 0;
    int exchange_mass_preconditioner_width = 0;
    bool cached_current_stats_valid = false;
    uint64_t cached_current_stats_step = 0;
    double cached_current_stats_time = 0.0;
    fullmag_fem_step_stats cached_current_stats{};
    FemCpuPgbbAcceptedGuard pgbb_accepted_guard;
};

int run_native_relaxation_step(
    Context &ctx,
    fullmag_fem_relax_algorithm algorithm,
    fullmag_fem_step_stats &out_stats,
    std::string &error);

} // namespace fullmag::fem

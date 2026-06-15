#pragma once

#include "fullmag_fem.h"

#include <cstdint>
#include <string>
#include <vector>

namespace mfem {
class SparseMatrix;
}

namespace fullmag::fem {

struct Context;

struct FemRelaxationRuntimeState {
    double step_size = 1.0e-6;
    bool use_bb1 = true;
    uint64_t reset_consecutive = 0;
    uint64_t accepted_steps = 0;
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
};

int run_native_relaxation_step(
    Context &ctx,
    fullmag_fem_relax_algorithm algorithm,
    fullmag_fem_step_stats &out_stats,
    std::string &error);

} // namespace fullmag::fem

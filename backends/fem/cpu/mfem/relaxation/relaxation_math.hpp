#pragma once

#include "fullmag_fem.h"

#include <string>
#include <vector>
#include <memory>

#if FULLMAG_HAS_MFEM_STACK
namespace mfem { class SparseMatrix; }
#endif

namespace fullmag::fem {

struct Context;

namespace relaxation {

inline constexpr double kDefaultStepSize = 1.0e-6;
inline constexpr double kMinStepSize = 1.0e-15;
inline constexpr double kMaxStepSize = 1.0e-3;
inline constexpr double kArmijoCoefficient = 1.0e-4;
inline constexpr uint32_t kProjectedGradientMaxBacktracks = 20;
inline constexpr uint32_t kNonlinearCgMaxBacktracks = 30;
inline constexpr uint32_t kTangentPlaneImplicitMaxBacktracks = 24;
inline constexpr uint64_t kNonlinearCgRestartInterval = 50;
inline constexpr double kDirectMinimizerPreconditionerMinimumStepMPerA = 1.0e-12;
inline constexpr double kDirectMinimizerPreconditionerMaximumStepMPerA = 1.0e-6;

#if FULLMAG_HAS_MFEM_STACK
std::unique_ptr<mfem::SparseMatrix> assemble_exchange_mass_preconditioner_for_step(
    mfem::SparseMatrix &mass_ms,
    mfem::SparseMatrix &exchange_stiffness_a,
    double step_m_per_a);
#endif

double dot_fields(
    const std::vector<double> &a,
    const std::vector<double> &b);

double gradient_norm_sq(const std::vector<double> &gradient);

double metric_dot_fields(
    const Context &ctx,
    const std::vector<double> &a,
    const std::vector<double> &b);

struct EnergyWeightedDotResult {
    double value = 0.0;
    double absolute_term_sum = 0.0;
};

// Energy-weighted metric: units depend on the units of a and b.
double energy_weighted_dot_fields(
    const Context &ctx,
    const std::vector<double> &a,
    const std::vector<double> &b);

EnergyWeightedDotResult energy_weighted_dot_fields_with_absolute_term_sum(
    const Context &ctx,
    const std::vector<double> &a,
    const std::vector<double> &b);

EnergyWeightedDotResult representable_chord_energy_linear_increment(
    const Context &ctx,
    const std::vector<double> &current_m_xyz,
    const std::vector<double> &trial_m_xyz,
    const std::vector<double> &current_h_eff_xyz);

double metric_gradient_norm_sq(
    const Context &ctx,
    const std::vector<double> &gradient);

void tangent_gradient_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_eff_xyz,
    std::vector<double> &gradient_xyz);

std::vector<double> project_tangent(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &vector_xyz);

bool transported_bb_secant(
    const Context &ctx,
    const std::vector<double> &previous_m,
    const std::vector<double> &accepted_m,
    const std::vector<double> &previous_gradient,
    const std::vector<double> &accepted_gradient,
    std::vector<double> &transported_step,
    std::vector<double> &transported_gradient_difference);

std::vector<double> negative_field(const std::vector<double> &field_xyz);

bool exchange_mass_preconditioned_gradient(
    Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &gradient_xyz,
    double step_m_per_a,
    std::vector<double> &preconditioned_gradient_xyz,
    std::string &error,
    uint64_t *preconditioner_wall_time_ns,
    uint32_t *preconditioner_cache_hits,
    uint32_t *preconditioner_cache_misses);

void destroy_exchange_mass_preconditioner_cache(Context &ctx);

bool validate_relaxation_state_fields(
    const Context &ctx,
    const char *algorithm_name,
    std::string &error);

bool validate_relaxation_step_energy(
    const fullmag_fem_step_stats &stats,
    const char *algorithm_name,
    const char *snapshot_name,
    std::string &error);

bool validate_tangent_gradient_norm_sq(
    double gradient_norm_sq,
    const char *algorithm_name,
    std::string &error);

bool validate_tangent_gradient_field(
    const Context &ctx,
    const std::vector<double> &gradient_xyz,
    const char *algorithm_name,
    const char *gradient_name,
    double &gradient_norm_sq,
    std::string &error);

double sanitized_relaxation_step_size(double step_size);

std::vector<double> retracted_step(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &direction_xyz,
    double step_size);

void retracted_step_into(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &direction_xyz,
    double step_size,
    std::vector<double> &trial_xyz);

int ensure_cpu_mfem_relaxation_lane(
    Context &ctx,
    const char *algorithm_name,
    std::string &error);

int upload_and_snapshot(
    Context &ctx,
    const std::vector<double> &m_xyz,
    fullmag_fem_step_stats &stats,
    const char *algorithm_name,
    const char *snapshot_name,
    std::string &error);

int fresh_line_search_snapshot(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    const char *algorithm_name,
    const char *snapshot_name,
    std::string &error);

bool take_cached_current_stats(
    Context &ctx,
    fullmag_fem_step_stats &stats);

int restore_after_failed_line_search(
    Context &ctx,
    const std::vector<double> &previous_m_xyz,
    const char *algorithm_name,
    uint32_t backtracks,
    const std::string &diagnostics,
    std::string &error);

int restore_after_rejected_trial(
    Context &ctx,
    const std::vector<double> &previous_m_xyz,
    const char *algorithm_name,
    uint32_t backtracks,
    double rejected_step_size,
    std::string &error);

int restore_previous_relaxation_state(
    Context &ctx,
    const std::vector<double> &previous_m_xyz,
    const char *algorithm_name,
    const char *failure_context,
    int original_status,
    const std::string &original_error,
    std::string &error);

void accumulate_relaxation_profile_sample(
    fullmag_fem_step_stats &accumulated_stats,
    const fullmag_fem_step_stats &sample_stats);

void finish_accepted_relaxation_step(
    Context &ctx,
    const fullmag_fem_step_stats &trial_stats,
    const fullmag_fem_step_stats &accumulated_stats,
    fullmag_fem_step_stats &out_stats,
    double accepted_step_size);

void publish_accepted_gradient_completion(
    Context &ctx,
    double accepted_gradient_norm_sq);

void finish_degenerate_gradient_relaxation_step(
    Context &ctx,
    const fullmag_fem_step_stats &current_stats,
    fullmag_fem_step_stats &out_stats,
    double gradient_norm_sq);

} // namespace relaxation

} // namespace fullmag::fem

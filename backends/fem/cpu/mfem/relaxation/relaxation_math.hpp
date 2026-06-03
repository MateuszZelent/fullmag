#pragma once

#include "fullmag_fem.h"

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

namespace relaxation {

inline constexpr double kDefaultStepSize = 1.0e-6;
inline constexpr double kMinStepSize = 1.0e-15;
inline constexpr double kMaxStepSize = 1.0e-3;
inline constexpr double kArmijoCoefficient = 1.0e-4;
inline constexpr double kGradientFloor = 1.0e-30;
inline constexpr double kBbCurvatureScale = 1.0e-6;
inline constexpr uint32_t kProjectedGradientMaxBacktracks = 20;
inline constexpr uint32_t kNonlinearCgMaxBacktracks = 30;
inline constexpr uint32_t kTangentPlaneImplicitMaxBacktracks = 24;
inline constexpr uint64_t kNonlinearCgRestartInterval = 50;

double dot_fields(
    const std::vector<double> &a,
    const std::vector<double> &b);

double gradient_norm_sq(const std::vector<double> &gradient);

double metric_dot_fields(
    const Context &ctx,
    const std::vector<double> &a,
    const std::vector<double> &b);

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

std::vector<double> negative_field(const std::vector<double> &field_xyz);

std::vector<double> retracted_step(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &direction_xyz,
    double step_size);

int ensure_cpu_mfem_relaxation_lane(
    Context &ctx,
    const char *algorithm_name,
    std::string &error);

int upload_and_snapshot(
    Context &ctx,
    const std::vector<double> &m_xyz,
    fullmag_fem_step_stats &stats,
    std::string &error);

void finish_accepted_relaxation_step(
    Context &ctx,
    const fullmag_fem_step_stats &trial_stats,
    fullmag_fem_step_stats &out_stats,
    double accepted_step_size);

} // namespace relaxation

} // namespace fullmag::fem

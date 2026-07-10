/* Real native field/energy directional-derivative contract for FEM Armijo. */

#include "fullmag_fem.h"

#include "context.hpp"
#include "cpu/mfem/relaxation/relaxation_math.hpp"
#include "fem_common.hpp"
#include "src/relaxation_numerics.hpp"
#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/relaxation/pgbb_kernels.hpp"
#endif

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

namespace {

constexpr size_t kNodeCount = 4;
constexpr size_t kFieldLength = 3 * kNodeCount;
constexpr double kEdge = 12.0e-9;
constexpr double kTetVolume = kEdge * kEdge * kEdge / 6.0;
constexpr double kP1LumpedVolume = kTetVolume / 4.0;
constexpr double kDemagSolveRtol = 1.0e-10;

const std::array<double, kFieldLength> kNodes = {
    0.0, 0.0, 0.0,
    kEdge, 0.0, 0.0,
    0.0, kEdge, 0.0,
    0.0, 0.0, kEdge,
};
const std::array<uint32_t, 4> kElements = {0, 1, 2, 3};
const std::array<uint32_t, 1> kElementMarkers = {1};
const std::array<uint32_t, 12> kBoundaryFaces = {
    0, 2, 1,
    0, 1, 3,
    0, 3, 2,
    1, 2, 3,
};
const std::array<uint32_t, 4> kBoundaryMarkers = {1, 1, 1, 1};
const std::array<double, kNodeCount> kMs = {4.0e5, 6.0e5, 8.0e5, 9.0e5};
const std::array<double, kNodeCount> kA = {1.1e-11, 1.3e-11, 1.5e-11, 1.7e-11};
const std::array<double, kNodeCount> kKu = {0.8e5, 1.1e5, 1.4e5, 1.8e5};
const std::array<double, 6> kStrain = {0.012, -0.008, 0.005, 0.003, -0.002, 0.004};

void check(bool condition, const std::string &message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message.c_str());
        std::exit(1);
    }
}

std::array<double, 3> normalized(std::array<double, 3> value)
{
    const double norm = std::sqrt(
        value[0] * value[0] + value[1] * value[1] + value[2] * value[2]);
    check(std::isfinite(norm) && norm > 0.0, "test vector must be normalizable");
    for (double &component : value) {
        component /= norm;
    }
    return value;
}

std::vector<double> initial_magnetization()
{
    const std::array<std::array<double, 3>, kNodeCount> raw = {{
        {0.8, 0.4, 0.2},
        {-0.3, 0.9, 0.2},
        {0.2, -0.4, 0.9},
        {-0.7, -0.2, 0.68},
    }};
    std::vector<double> result(kFieldLength, 0.0);
    for (size_t node = 0; node < kNodeCount; ++node) {
        const auto m = normalized(raw[node]);
        for (size_t component = 0; component < 3; ++component) {
            result[3 * node + component] = m[component];
        }
    }
    return result;
}

std::vector<double> tangent_direction(const std::vector<double> &m)
{
    const std::array<std::array<double, 3>, kNodeCount> raw = {{
        {-0.2, 0.7, 0.3},
        {0.6, 0.1, -0.5},
        {-0.4, 0.8, 0.2},
        {0.3, -0.6, 0.7},
    }};
    std::vector<double> p(kFieldLength, 0.0);
    for (size_t node = 0; node < kNodeCount; ++node) {
        const size_t base = 3 * node;
        const double mdotq =
            m[base] * raw[node][0] +
            m[base + 1] * raw[node][1] +
            m[base + 2] * raw[node][2];
        std::array<double, 3> projected = {
            raw[node][0] - mdotq * m[base],
            raw[node][1] - mdotq * m[base + 1],
            raw[node][2] - mdotq * m[base + 2],
        };
        projected = normalized(projected);
        for (size_t component = 0; component < 3; ++component) {
            p[base + component] = projected[component];
        }
    }
    return p;
}

std::vector<double> retract(
    const std::vector<double> &m,
    const std::vector<double> &p,
    double epsilon)
{
    std::vector<double> out(kFieldLength, 0.0);
    for (size_t node = 0; node < kNodeCount; ++node) {
        const size_t base = 3 * node;
        std::array<double, 3> value = {
            m[base] + epsilon * p[base],
            m[base + 1] + epsilon * p[base + 1],
            m[base + 2] + epsilon * p[base + 2],
        };
        value = normalized(value);
        for (size_t component = 0; component < 3; ++component) {
            out[base + component] = value[component];
        }
    }
    return out;
}

enum class Interaction {
    Exchange,
    Zeeman,
    Pma,
    Cubic,
    Dmi,
    Demag,
    Magnetoelastic,
};

const char *interaction_name(Interaction interaction)
{
    switch (interaction) {
    case Interaction::Exchange: return "exchange";
    case Interaction::Zeeman: return "zeeman";
    case Interaction::Pma: return "pma";
    case Interaction::Cubic: return "cubic";
    case Interaction::Dmi: return "dmi";
    case Interaction::Demag: return "demag";
    case Interaction::Magnetoelastic: return "prescribed_strain_magnetoelasticity";
    }
    return "unknown";
}

fullmag_fem_observable interaction_observable(Interaction interaction)
{
    switch (interaction) {
    case Interaction::Exchange: return FULLMAG_FEM_OBSERVABLE_H_EX;
    case Interaction::Zeeman: return FULLMAG_FEM_OBSERVABLE_H_EXT;
    case Interaction::Pma: return FULLMAG_FEM_OBSERVABLE_H_ANI;
    case Interaction::Cubic: return FULLMAG_FEM_OBSERVABLE_H_ANI_CUBIC;
    case Interaction::Dmi: return FULLMAG_FEM_OBSERVABLE_H_DMI_BULK;
    case Interaction::Demag: return FULLMAG_FEM_OBSERVABLE_H_DEMAG;
    case Interaction::Magnetoelastic: return FULLMAG_FEM_OBSERVABLE_H_MEL;
    }
    return FULLMAG_FEM_OBSERVABLE_H_EFF;
}

double interaction_energy(
    Interaction interaction,
    const fullmag_fem_step_stats &stats)
{
    switch (interaction) {
    case Interaction::Exchange: return stats.exchange_energy_joules;
    case Interaction::Zeeman: return stats.external_energy_joules;
    case Interaction::Pma:
    case Interaction::Cubic: return stats.anisotropy_energy_joules;
    case Interaction::Dmi: return stats.dmi_energy_joules;
    case Interaction::Demag: return stats.demag_energy_joules;
    case Interaction::Magnetoelastic: return stats.magnetoelastic_energy_joules;
    }
    return std::numeric_limits<double>::quiet_NaN();
}

fullmag_fem_plan_desc plan_for(
    Interaction interaction,
    const std::vector<double> &m)
{
    fullmag_fem_plan_desc plan{};
    plan.mesh.nodes_xyz = kNodes.data();
    plan.mesh.n_nodes = kNodeCount;
    plan.mesh.elements = kElements.data();
    plan.mesh.n_elements = 1;
    plan.mesh.element_markers = kElementMarkers.data();
    plan.mesh.boundary_faces = kBoundaryFaces.data();
    plan.mesh.n_boundary_faces = 4;
    plan.mesh.boundary_markers = kBoundaryMarkers.data();
    plan.material.saturation_magnetisation = 6.0e5;
    plan.material.exchange_stiffness = 1.3e-11;
    plan.material.damping = 0.1;
    plan.material.gyromagnetic_ratio = 2.211e5;
    plan.ms_field = kMs.data();
    plan.ms_field_len = kMs.size();
    plan.fe_order = 1;
    plan.hmax = kEdge;
    plan.precision = FULLMAG_FEM_PRECISION_DOUBLE;
    plan.integrator = FULLMAG_FEM_INTEGRATOR_HEUN;
    plan.initial_magnetization_xyz = m.data();
    plan.initial_magnetization_len = m.size();
    plan.dt_seconds = 1.0e-15;
    plan.demag_realization = FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER;
    plan.gpu_device_index = -1;
    plan.mfem_device_string = "cpu";
    plan.eager_initial_effective_field = 1;
    plan.demag_solver.solver = FULLMAG_FEM_LINEAR_SOLVER_GMRES;
    plan.demag_solver.preconditioner = FULLMAG_FEM_PRECONDITIONER_JACOBI;
    plan.demag_solver.relative_tolerance = kDemagSolveRtol;
    plan.demag_solver.has_absolute_tolerance = 1;
    plan.demag_solver.absolute_tolerance = 1.0e-14;
    plan.demag_solver.max_iterations = 500;

    switch (interaction) {
    case Interaction::Exchange:
        plan.enable_exchange = 1;
        plan.a_field = kA.data();
        plan.a_field_len = kA.size();
        break;
    case Interaction::Zeeman:
        plan.has_external_field = 1;
        plan.external_field_am[0] = 1.7e5;
        plan.external_field_am[1] = -0.8e5;
        plan.external_field_am[2] = 0.6e5;
        break;
    case Interaction::Pma:
        plan.has_uniaxial_anisotropy = 1;
        plan.uniaxial_anisotropy_constant = 1.2e5;
        plan.uniaxial_anisotropy_k2 = 0.3e5;
        plan.anisotropy_axis[2] = 1.0;
        plan.ku_field = kKu.data();
        plan.ku_field_len = kKu.size();
        break;
    case Interaction::Cubic:
        plan.has_cubic_anisotropy = 1;
        plan.cubic_kc1 = 4.0e4;
        plan.cubic_kc2 = 2.0e4;
        plan.cubic_kc3 = 1.0e4;
        plan.cubic_axis1[0] = 1.0;
        plan.cubic_axis2[1] = 1.0;
        break;
    case Interaction::Dmi:
        plan.ms_field = nullptr;
        plan.ms_field_len = 0;
        plan.has_bulk_dmi = 1;
        plan.bulk_dmi_constant = 2.0e-3;
        break;
    case Interaction::Demag:
        plan.ms_field = nullptr;
        plan.ms_field_len = 0;
        plan.enable_demag = 1;
        plan.air_box_factor = 1.0;
        plan.poisson_boundary_marker = 1;
        plan.robin_beta_mode = 2;
        break;
    case Interaction::Magnetoelastic:
        plan.has_magnetoelastic = 1;
        plan.mel_b1 = 1.5e6;
        plan.mel_b2 = -2.5e6;
        plan.mel_uniform_strain = 1;
        plan.mel_strain_voigt = kStrain.data();
        plan.mel_strain_len = kStrain.size();
        break;
    }
    return plan;
}

class Backend {
public:
    Backend(Interaction interaction, const std::vector<double> &m)
        : interaction_(interaction), plan_(plan_for(interaction, m))
    {
        handle_ = fullmag_fem_backend_create(&plan_);
        check(
            handle_ != nullptr,
            std::string("backend create for ") + interaction_name(interaction_) +
                ": " + safe_error(nullptr));
    }

    ~Backend()
    {
        fullmag_fem_backend_destroy(handle_);
    }

    fullmag_fem_step_stats snapshot(const std::vector<double> &m)
    {
        check(
            fullmag_fem_backend_upload_magnetization_f64(handle_, m.data(), m.size()) ==
                FULLMAG_FEM_OK,
            std::string("upload m for ") + interaction_name(interaction_) +
                ": " + safe_error(handle_));
        fullmag_fem_step_stats stats{};
        check(
            fullmag_fem_backend_snapshot_stats(handle_, &stats) == FULLMAG_FEM_OK,
            std::string("snapshot for ") + interaction_name(interaction_) +
                ": " + safe_error(handle_));
        return stats;
    }

    std::vector<double> field()
    {
        std::vector<double> result(kFieldLength, 0.0);
        check(
            fullmag_fem_backend_copy_field_f64(
                handle_,
                interaction_observable(interaction_),
                result.data(),
                result.size()) == FULLMAG_FEM_OK,
            std::string("copy field for ") + interaction_name(interaction_) +
                ": " + safe_error(handle_));
        return result;
    }

private:
    static const char *safe_error(fullmag_fem_backend *handle)
    {
        const char *error = fullmag_fem_backend_last_error(handle);
        return error == nullptr ? "unknown native error" : error;
    }

    Interaction interaction_;
    fullmag_fem_plan_desc plan_{};
    fullmag_fem_backend *handle_ = nullptr;
};

struct AnalyticDerivative {
    double value_j = 0.0;
    double absolute_term_sum_j = 0.0;
};

AnalyticDerivative analytic_directional_derivative(
    Interaction interaction,
    const std::vector<double> &field,
    const std::vector<double> &p)
{
    AnalyticDerivative derivative;
    for (size_t node = 0; node < kNodeCount; ++node) {
        const size_t base = 3 * node;
        const double ms =
            interaction == Interaction::Dmi || interaction == Interaction::Demag
                ? 6.0e5
                : kMs[node];
        const double weight = -fullmag::fem::kMu0 * ms * kP1LumpedVolume;
        for (size_t component = 0; component < 3; ++component) {
            const double scalar_term =
                weight * field[base + component] * p[base + component];
            derivative.value_j += scalar_term;
            derivative.absolute_term_sum_j += std::abs(scalar_term);
        }
    }
    return derivative;
}

bool check_interaction_directional_derivative(Interaction interaction)
{
    const std::vector<double> m = initial_magnetization();
    const std::vector<double> p = tangent_direction(m);
    Backend backend(interaction, m);
    const fullmag_fem_step_stats initial_stats = backend.snapshot(m);
    const std::vector<double> field = backend.field();
    const AnalyticDerivative analytic_result =
        analytic_directional_derivative(interaction, field, p);
    const double analytic = analytic_result.value_j;
    check(std::isfinite(analytic), std::string(interaction_name(interaction)) + " analytic slope finite");

    const std::array<double, 6> epsilons = {
        2.0e-3, 1.0e-3, 5.0e-4, 2.5e-4, 1.25e-4, 6.25e-5,
    };
    double best_error = std::numeric_limits<double>::infinity();
    double best_error_bound = 0.0;
    double best_fd_error = std::numeric_limits<double>::infinity();
    double best_fd_error_bound = 0.0;
    double previous_fd = std::numeric_limits<double>::quiet_NaN();
    double previous_roundoff_bound = std::numeric_limits<double>::quiet_NaN();
    double previous_fd_error = std::numeric_limits<double>::quiet_NaN();
    double last_fd = std::numeric_limits<double>::quiet_NaN();
    bool derivative_ok = false;
    bool fd_convergence_ok = false;
    for (double epsilon : epsilons) {
        const auto plus = backend.snapshot(retract(m, p, epsilon));
        const auto minus = backend.snapshot(retract(m, p, -epsilon));
        const double plus_energy = interaction_energy(interaction, plus);
        const double minus_energy = interaction_energy(interaction, minus);
        const double fd =
            (plus_energy - minus_energy) / (2.0 * epsilon);
        check(std::isfinite(fd), std::string(interaction_name(interaction)) + " finite FD slope");
        const double error = std::abs(fd - analytic);
        const double energy_scale = std::max(std::abs(plus_energy), std::abs(minus_energy));
        const double roundoff_bound =
            8.0 * std::numeric_limits<double>::epsilon() * energy_scale / epsilon;
        const double analytic_roundoff_bound =
            fullmag::fem::relaxation::reduction_roundoff_bound(kFieldLength) *
            analytic_result.absolute_term_sum_j;
        if (std::isfinite(previous_fd)) {
            const double fd_error = std::abs(fd - previous_fd) / 3.0;
            const double fd_roundoff_bound =
                (roundoff_bound + previous_roundoff_bound) / 3.0;
            const double error_bound =
                fd_error + fd_roundoff_bound + analytic_roundoff_bound;
            if (error < best_error) {
                best_error = error;
                best_error_bound = error_bound;
            }
            derivative_ok = derivative_ok || error <= error_bound;
            const double fd_error_bound = std::isfinite(previous_fd_error)
                ? 0.5 * previous_fd_error + fd_roundoff_bound
                : std::numeric_limits<double>::infinity();
            if (std::isfinite(previous_fd_error) && fd_error < best_fd_error) {
                best_fd_error = fd_error;
                best_fd_error_bound = fd_error_bound;
            }
            if (std::isfinite(previous_fd_error)) {
                fd_convergence_ok = fd_convergence_ok || fd_error <= fd_error_bound;
            }
            previous_fd_error = fd_error;
        }
        previous_fd = fd;
        previous_roundoff_bound = roundoff_bound;
        last_fd = fd;
    }
    std::printf(
        "DERIVATIVE interaction=%s energy_j=%.17e analytic_j=%.17e absolute_term_sum_j=%.17e absolute_term_granularity=scalar_component analytic_roundoff_bound_j=%.17e last_fd_j=%.17e best_error_j=%.17e derivative_bound_j=%.17e fd_error_j=%.17e fd_bound_j=%.17e solve_residual=%.17e\n",
        interaction_name(interaction),
        interaction_energy(interaction, initial_stats),
        analytic,
        analytic_result.absolute_term_sum_j,
        fullmag::fem::relaxation::reduction_roundoff_bound(kFieldLength) *
            analytic_result.absolute_term_sum_j,
        last_fd,
        best_error,
        best_error_bound,
        best_fd_error,
        best_fd_error_bound,
        interaction == Interaction::Demag ? initial_stats.demag_linear_residual : 0.0);
    check(
        std::isfinite(best_fd_error),
        std::string(interaction_name(interaction)) + " must expose an FD truncation estimate");
    check(
        fd_convergence_ok,
        std::string(interaction_name(interaction)) +
            " FD Richardson estimate must satisfy its scale-derived bound");
    if (interaction == Interaction::Demag) {
        check(
            std::isfinite(initial_stats.demag_linear_residual) &&
                initial_stats.demag_linear_residual <= kDemagSolveRtol,
            "demag solve error must be reported separately and satisfy the configured solve tolerance");
    }
    return derivative_ok;
}

void analytic_absolute_term_sum_resolves_component_cancellation()
{
    std::vector<double> field(kFieldLength, 0.0);
    std::vector<double> direction(kFieldLength, 0.0);
    field[0] = 1.0;
    field[1] = -1.0;
    direction[0] = 1.0;
    direction[1] = 1.0;

    const auto derivative = analytic_directional_derivative(
        Interaction::Zeeman, field, direction);
    const double expected_absolute_term_sum =
        2.0 * fullmag::fem::kMu0 * kMs[0] * kP1LumpedVolume;
    check(
        derivative.value_j == 0.0,
        "analytic derivative cancellation fixture must have an exact zero signed sum");
    check(
        std::abs(derivative.absolute_term_sum_j - expected_absolute_term_sum) <=
            2.0 * std::numeric_limits<double>::epsilon() * expected_absolute_term_sum,
        "analytic derivative absolute-term sum must resolve scalar-component cancellation within one node");
}

void cpu_energy_weight_uses_nodal_ms_and_uniform_fallback()
{
    fullmag::fem::Context ctx;
    ctx.mesh.magnetic_node_mask = {1u, 1u};
    ctx.integration_weights.mfem_lumped_mass = {2.0e-27, 5.0e-27};
    ctx.material_fields.material.saturation_magnetisation = 6.0e5;
    ctx.material_fields.Ms_field = {4.0e5};
    const std::vector<double> a = {1.0, 2.0, 3.0, -1.0, 0.5, 2.0};
    const std::vector<double> b = {0.5, -1.0, 4.0, 2.0, 1.5, -0.5};
    const double expected = fullmag::fem::kMu0 *
        (4.0e5 * 2.0e-27 * (0.5 - 2.0 + 12.0) +
         6.0e5 * 5.0e-27 * (-2.0 + 0.75 - 1.0));
    const auto detailed =
        fullmag::fem::relaxation::energy_weighted_dot_fields_with_absolute_term_sum(
            ctx, a, b);
    const double actual = detailed.value;
    double expected_absolute_term_sum = 0.0;
    for (size_t node = 0; node < 2; ++node) {
        const double ms = node == 0 ? 4.0e5 : 6.0e5;
        const double weight = fullmag::fem::kMu0 * ms *
            ctx.integration_weights.mfem_lumped_mass[node];
        for (size_t component = 0; component < 3; ++component) {
            const size_t index = 3 * node + component;
            expected_absolute_term_sum += std::abs(weight * a[index] * b[index]);
        }
    }
    check(
        std::abs(actual - expected) <= 1.0e-32 + 2.0e-15 * std::abs(expected),
        "CPU energy-weighted dot must use nodal Ms where supplied and uniform Ms fallback otherwise");
    check(
        std::abs(detailed.absolute_term_sum - expected_absolute_term_sum) <=
            1.0e-32 + 2.0e-15 * expected_absolute_term_sum,
        "CPU signed energy product must expose the actual absolute scalar-term sum");

    fullmag::fem::Context cancellation_ctx;
    cancellation_ctx.mesh.magnetic_node_mask = {1u, 1u};
    cancellation_ctx.integration_weights.mfem_lumped_mass = {1.0e-27, 1.0e-27};
    cancellation_ctx.material_fields.Ms_field = {8.0e5, 8.0e5};
    const std::vector<double> cancellation_a = {1.0, 0.0, 0.0, 1.0, 0.0, 0.0};
    const std::vector<double> cancellation_b = {
        1.0, 0.0, 0.0, -std::nextafter(1.0, 0.0), 0.0, 0.0};
    const auto cancellation =
        fullmag::fem::relaxation::energy_weighted_dot_fields_with_absolute_term_sum(
            cancellation_ctx, cancellation_a, cancellation_b);
    check(
        !fullmag::fem::relaxation::positive_signed_reduction_resolved(
            cancellation.value,
            cancellation.absolute_term_sum,
            cancellation_a.size()),
        "CPU signed PR+ denominator hidden by cancellation must be rejected using its actual absolute-term sum");
}

void dimension_aware_reduction_guards_are_scale_relative()
{
    using fullmag::fem::relaxation::positive_bb_curvature_resolved;
    using fullmag::fem::relaxation::positive_nonnegative_reduction_resolved;
    using fullmag::fem::relaxation::positive_signed_reduction_resolved;
    check(
        positive_bb_curvature_resolved(1.0e-42, 5.0e-31, 1.0e-18, 12),
        "BB guard must accept resolved positive curvature below any shared absolute floor");
    check(
        !positive_bb_curvature_resolved(1.0, 1.0e-18, 1.0, 12),
        "BB guard must reject curvature hidden by reduction roundoff at its local joule scale");
    check(
        positive_signed_reduction_resolved(1.0e-40, 1.5e-40, 12),
        "signed PR+ guard must accept a denominator resolved against its absolute-term sum");
    check(
        !positive_signed_reduction_resolved(1.0e-40, 1.0, 12),
        "signed PR+ guard must reject cancellation hidden by its absolute-term sum");
    check(
        positive_nonnegative_reduction_resolved(1.0e-300, 12),
        "nonnegative GPU PR+ square-sum guard must not depend on the signed numerator");
}

void strict_monotone_energy_scale_sweep()
{
    using fullmag::fem::relaxation::strict_monotone_energy_accept;
    for (double magnitude : {std::numeric_limits<double>::denorm_min(), 1.0e-200,
             1.0e-23, 1.0, 1.0e200}) {
        for (double current : {magnitude, -magnitude}) {
            check(strict_monotone_energy_accept(current, current),
                "strict monotone recovery must accept exactly equal finite energy");
            check(strict_monotone_energy_accept(
                      current, std::nextafter(current, -std::numeric_limits<double>::infinity())),
                "strict monotone recovery must accept one-ulp energy decrease");
            check(!strict_monotone_energy_accept(
                      current, std::nextafter(current, std::numeric_limits<double>::infinity())),
                "strict monotone recovery must reject one-ulp energy increase at every scale");
        }
    }
}

#if FULLMAG_HAS_CUDA_RUNTIME
void check_cuda(cudaError_t status, const char *message)
{
    check(status == cudaSuccess, std::string(message) + ": " + cudaGetErrorString(status));
}

template <typename T>
T *copy_to_device(const std::vector<T> &host)
{
    T *device = nullptr;
    check_cuda(cudaMalloc(&device, host.size() * sizeof(T)), "cudaMalloc");
    check_cuda(
        cudaMemcpy(device, host.data(), host.size() * sizeof(T), cudaMemcpyHostToDevice),
        "cudaMemcpy host-to-device");
    return device;
}

double copy_scalar_from_device(const double *device)
{
    double value = 0.0;
    check_cuda(
        cudaMemcpy(&value, device, sizeof(double), cudaMemcpyDeviceToHost),
        "cudaMemcpy scalar device-to-host");
    return value;
}

std::vector<double> copy_vector_from_device(const double *device, size_t size)
{
    std::vector<double> value(size, 0.0);
    check_cuda(
        cudaMemcpy(
            value.data(), device, size * sizeof(double), cudaMemcpyDeviceToHost),
        "cudaMemcpy vector device-to-host");
    return value;
}

void cuda_heterogeneous_nodal_ms_pgbb_ncg_calibration()
{
    constexpr int calibration_node_count = 3;
    const std::vector<double> previous_x = {1.0, 0.0, 0.0};
    const std::vector<double> previous_y = {0.0, 1.0, 0.0};
    const std::vector<double> previous_z = {0.0, 0.0, 1.0};
    const std::vector<double> trial_x = {0.8, 0.1, 1.0e6};
    const std::vector<double> trial_y = {0.2, 0.9, -1.0e6};
    const std::vector<double> trial_z = {0.1, 0.3, 5.0e5};
    const std::vector<double> previous_gx = {2.0, -1.0, 1.0e12};
    const std::vector<double> previous_gy = {-3.0, 4.0, -2.0e12};
    const std::vector<double> previous_gz = {1.0, 2.0, 3.0e12};
    const std::vector<double> trial_gx = {3.0, 1.0, -4.0e12};
    const std::vector<double> trial_gy = {-1.0, 2.0, 5.0e12};
    const std::vector<double> trial_gz = {2.0, -1.0, -6.0e12};
    const std::vector<double> ms = {4.0e5, 9.0e5, 7.0e12};
    const std::vector<double> volume = {2.0e-27, 5.0e-27, 1.0e-15};
    const std::vector<uint8_t> mask = {1u, 1u, 0u};

    double *d_previous_x = copy_to_device(previous_x);
    double *d_previous_y = copy_to_device(previous_y);
    double *d_previous_z = copy_to_device(previous_z);
    double *d_trial_x = copy_to_device(trial_x);
    double *d_trial_y = copy_to_device(trial_y);
    double *d_trial_z = copy_to_device(trial_z);
    double *d_previous_gx = copy_to_device(previous_gx);
    double *d_previous_gy = copy_to_device(previous_gy);
    double *d_previous_gz = copy_to_device(previous_gz);
    double *d_trial_gx = copy_to_device(trial_gx);
    double *d_trial_gy = copy_to_device(trial_gy);
    double *d_trial_gz = copy_to_device(trial_gz);
    double *d_ms = copy_to_device(ms);
    double *d_volume = copy_to_device(volume);
    uint8_t *d_mask = copy_to_device(mask);
    double *d_ss = copy_to_device(std::vector<double>{0.0});
    double *d_sy = copy_to_device(std::vector<double>{0.0});
    double *d_yy = copy_to_device(std::vector<double>{0.0});

    fullmag::fem::fullmag_cuda_relax_bb_curvature_blocks(
        d_previous_x, d_previous_y, d_previous_z,
        d_trial_x, d_trial_y, d_trial_z,
        d_previous_gx, d_previous_gy, d_previous_gz,
        d_trial_gx, d_trial_gy, d_trial_gz,
        d_ms, d_volume, d_mask, d_ss, d_sy, d_yy, calibration_node_count);
    check_cuda(cudaGetLastError(), "CUDA BB curvature launch");
    check_cuda(cudaDeviceSynchronize(), "CUDA BB curvature synchronize");

    double expected_ss = 0.0;
    double expected_sy = 0.0;
    double expected_yy = 0.0;
    for (size_t node = 0; node < mask.size(); ++node) {
        if (mask[node] == 0u) {
            continue;
        }
        const double weight = fullmag::fem::kMu0 * ms[node] * volume[node];
        const std::array<double, 3> s = {
            trial_x[node] - previous_x[node],
            trial_y[node] - previous_y[node],
            trial_z[node] - previous_z[node],
        };
        const std::array<double, 3> y = {
            trial_gx[node] - previous_gx[node],
            trial_gy[node] - previous_gy[node],
            trial_gz[node] - previous_gz[node],
        };
        expected_ss += weight * (s[0] * s[0] + s[1] * s[1] + s[2] * s[2]);
        expected_sy += weight * (s[0] * y[0] + s[1] * y[1] + s[2] * y[2]);
        expected_yy += weight * (y[0] * y[0] + y[1] * y[1] + y[2] * y[2]);
    }
    const auto near = [](double actual, double expected) {
        return std::abs(actual - expected) <= 1.0e-45 + 3.0e-15 * std::abs(expected);
    };
    const double gpu_ss = copy_scalar_from_device(d_ss);
    const double gpu_sy = copy_scalar_from_device(d_sy);
    const double gpu_yy = copy_scalar_from_device(d_yy);
    check(near(gpu_ss, expected_ss), "CUDA BB s dot s uses mu0 Ms V");
    check(near(gpu_sy, expected_sy), "CUDA BB s dot y uses mu0 Ms V");
    check(near(gpu_yy, expected_yy), "CUDA BB y dot y uses mu0 Ms V");

    constexpr double default_step = 1.0e-6;
    constexpr double min_step = 1.0e-15;
    constexpr double max_step = 1.0e-3;
    const double calibrated_sy = 0.5 * std::sqrt(gpu_ss) * std::sqrt(gpu_yy);
    const auto bb1 = fullmag::fem::relaxation::bb_step_decision(
        gpu_ss, calibrated_sy, gpu_yy, 6, true, 0,
        default_step, min_step, max_step);
    const auto bb2 = fullmag::fem::relaxation::bb_step_decision(
        gpu_ss, calibrated_sy, gpu_yy, 6, false, 0,
        default_step, min_step, max_step);
    check(
        bb1.curvature_accepted &&
            bb1.step_size == std::clamp(gpu_ss / calibrated_sy, min_step, max_step),
        "heterogeneous nodal Ms PGBB calibration must apply the BB1 candidate and clamp");
    check(
        bb2.curvature_accepted &&
            bb2.step_size == std::clamp(calibrated_sy / gpu_yy, min_step, max_step),
        "heterogeneous nodal Ms PGBB calibration must apply the BB2 candidate and clamp");
    const auto reset = fullmag::fem::relaxation::bb_step_decision(
        gpu_ss, -std::abs(calibrated_sy), gpu_yy, 6, true, 0,
        default_step, min_step, max_step);
    check(
        !reset.curvature_accepted && reset.reset_consecutive == 1u &&
            reset.step_size == default_step / 2.0,
        "heterogeneous nodal Ms PGBB calibration must apply the reset seed policy");

    const std::vector<double> ncg_hx = {1.0, -3.0, 7.0e12};
    const std::vector<double> ncg_hy = {2.0, 1.0, -8.0e12};
    const std::vector<double> ncg_hz = {-1.0, 2.0, 9.0e12};
    const std::vector<double> previous_px = {-2.0, 1.0, -1.0e12};
    const std::vector<double> previous_py = {3.0, -4.0, 2.0e12};
    const std::vector<double> previous_pz = {-1.0, -2.0, -3.0e12};
    double *d_ncg_hx = copy_to_device(ncg_hx);
    double *d_ncg_hy = copy_to_device(ncg_hy);
    double *d_ncg_hz = copy_to_device(ncg_hz);
    double *d_previous_px = copy_to_device(previous_px);
    double *d_previous_py = copy_to_device(previous_py);
    double *d_previous_pz = copy_to_device(previous_pz);
    double *d_next_px = copy_to_device(std::vector<double>{1.0e11, -2.0e11, 3.0e11});
    double *d_next_py = copy_to_device(std::vector<double>{-4.0e11, 5.0e11, -6.0e11});
    double *d_next_pz = copy_to_device(std::vector<double>{7.0e11, -8.0e11, 9.0e11});

    fullmag::fem::fullmag_cuda_relax_ncg_gradient_norm_and_pr_plus_blocks(
        d_previous_x, d_previous_y, d_previous_z,
        d_ncg_hx, d_ncg_hy, d_ncg_hz,
        d_previous_gx, d_previous_gy, d_previous_gz,
        d_ms, d_volume, d_mask,
        d_trial_gx, d_trial_gy, d_trial_gz,
        d_ss, d_sy, d_yy, calibration_node_count);
    check_cuda(cudaGetLastError(), "CUDA production NCG gradient/PR+ launch");
    check_cuda(cudaDeviceSynchronize(), "CUDA production NCG gradient/PR+ synchronize");

    std::array<std::vector<double>, 3> expected_trial_gradient = {
        std::vector<double>(mask.size(), 0.0),
        std::vector<double>(mask.size(), 0.0),
        std::vector<double>(mask.size(), 0.0),
    };
    double expected_trial_volume_norm_sq = 0.0;
    double expected_previous_energy_norm_sq = 0.0;
    double expected_pr_plus_numerator = 0.0;
    for (size_t node = 0; node < mask.size(); ++node) {
        if (mask[node] == 0u) {
            continue;
        }
        const std::array<double, 3> m = {
            previous_x[node], previous_y[node], previous_z[node]};
        const std::array<double, 3> h = {
            ncg_hx[node], ncg_hy[node], ncg_hz[node]};
        const std::array<double, 3> previous_g = {
            previous_gx[node], previous_gy[node], previous_gz[node]};
        const double mdoth = m[0] * h[0] + m[1] * h[1] + m[2] * h[2];
        const double mdot_previous_g =
            m[0] * previous_g[0] + m[1] * previous_g[1] + m[2] * previous_g[2];
        std::array<double, 3> trial_g{};
        std::array<double, 3> transported_previous_g{};
        double trial_norm_sq = 0.0;
        double previous_norm_sq = 0.0;
        double numerator = 0.0;
        for (size_t component = 0; component < 3; ++component) {
            trial_g[component] = -(h[component] - mdoth * m[component]);
            transported_previous_g[component] =
                previous_g[component] - mdot_previous_g * m[component];
            expected_trial_gradient[component][node] = trial_g[component];
            trial_norm_sq += trial_g[component] * trial_g[component];
            previous_norm_sq += previous_g[component] * previous_g[component];
            numerator += trial_g[component] *
                (trial_g[component] - transported_previous_g[component]);
        }
        const double energy_weight = fullmag::fem::kMu0 * ms[node] * volume[node];
        expected_trial_volume_norm_sq += volume[node] * trial_norm_sq;
        expected_previous_energy_norm_sq += energy_weight * previous_norm_sq;
        expected_pr_plus_numerator += energy_weight * numerator;
    }

    const std::array<std::vector<double>, 3> gpu_trial_gradient = {
        copy_vector_from_device(d_trial_gx, mask.size()),
        copy_vector_from_device(d_trial_gy, mask.size()),
        copy_vector_from_device(d_trial_gz, mask.size()),
    };
    for (size_t component = 0; component < 3; ++component) {
        for (size_t node = 0; node < mask.size(); ++node) {
            check(
                near(gpu_trial_gradient[component][node],
                    expected_trial_gradient[component][node]),
                "production CUDA NCG tangent gradient must match the independent CPU oracle");
        }
    }
    const double gpu_trial_volume_norm_sq = copy_scalar_from_device(d_ss);
    const double gpu_previous_energy_norm_sq = copy_scalar_from_device(d_sy);
    const double gpu_pr_plus_numerator = copy_scalar_from_device(d_yy);
    check(
        near(gpu_trial_volume_norm_sq, expected_trial_volume_norm_sq),
        "production CUDA NCG volume norm must match the independent CPU oracle");
    check(
        near(gpu_previous_energy_norm_sq, expected_previous_energy_norm_sq),
        "production CUDA NCG denominator must use heterogeneous nodal mu0 Ms V weights");
    check(
        near(gpu_pr_plus_numerator, expected_pr_plus_numerator),
        "production CUDA NCG numerator must use heterogeneous nodal mu0 Ms V weights");
    check(
        fullmag::fem::relaxation::positive_nonnegative_reduction_resolved(
            gpu_previous_energy_norm_sq, 3u * mask.size()),
        "production CUDA NCG square-sum denominator must be numerically resolved");

    const double relative_roundoff_bound =
        fullmag::fem::relaxation::reduction_roundoff_bound(3u * mask.size());
    fullmag::fem::fullmag_cuda_relax_ncg_update_direction_from_reduced_pr_plus(
        d_previous_x, d_previous_y, d_previous_z,
        d_trial_gx, d_trial_gy, d_trial_gz,
        d_previous_px, d_previous_py, d_previous_pz,
        d_sy, d_yy, d_ms, d_volume, d_mask,
        relative_roundoff_bound, true, false,
        d_next_px, d_next_py, d_next_pz, d_ss, calibration_node_count);
    check_cuda(cudaGetLastError(), "CUDA production NCG direction update launch");
    check_cuda(cudaDeviceSynchronize(), "CUDA production NCG direction update synchronize");

    const double expected_beta =
        expected_previous_energy_norm_sq >
                relative_roundoff_bound * expected_previous_energy_norm_sq
            ? std::max(0.0, expected_pr_plus_numerator /
                    expected_previous_energy_norm_sq)
            : 0.0;
    std::array<std::vector<double>, 3> expected_next_direction = {
        std::vector<double>(mask.size(), 0.0),
        std::vector<double>(mask.size(), 0.0),
        std::vector<double>(mask.size(), 0.0),
    };
    double expected_p_dot_g = 0.0;
    double expected_direction_volume_norm_sq = 0.0;
    for (size_t node = 0; node < mask.size(); ++node) {
        if (mask[node] == 0u) {
            continue;
        }
        const std::array<double, 3> m = {
            previous_x[node], previous_y[node], previous_z[node]};
        const std::array<double, 3> previous_p = {
            previous_px[node], previous_py[node], previous_pz[node]};
        const double mdot_previous_p =
            m[0] * previous_p[0] + m[1] * previous_p[1] + m[2] * previous_p[2];
        double node_p_dot_g = 0.0;
        double node_direction_norm_sq = 0.0;
        for (size_t component = 0; component < 3; ++component) {
            const double transported_previous_p =
                previous_p[component] - mdot_previous_p * m[component];
            const double next_direction =
                -expected_trial_gradient[component][node] +
                expected_beta * transported_previous_p;
            expected_next_direction[component][node] = next_direction;
            node_p_dot_g +=
                next_direction * expected_trial_gradient[component][node];
            node_direction_norm_sq += next_direction * next_direction;
        }
        expected_p_dot_g +=
            fullmag::fem::kMu0 * ms[node] * volume[node] * node_p_dot_g;
        expected_direction_volume_norm_sq += volume[node] * node_direction_norm_sq;
    }
    const std::array<std::vector<double>, 3> gpu_next_direction = {
        copy_vector_from_device(d_next_px, mask.size()),
        copy_vector_from_device(d_next_py, mask.size()),
        copy_vector_from_device(d_next_pz, mask.size()),
    };
    for (size_t component = 0; component < 3; ++component) {
        for (size_t node = 0; node < mask.size(); ++node) {
            check(
                near(gpu_next_direction[component][node],
                    expected_next_direction[component][node]),
                "production CUDA NCG PR+ direction must match the independent CPU oracle");
        }
    }
    const double gpu_p_dot_g = copy_scalar_from_device(d_ss);
    check(
        near(gpu_p_dot_g, expected_p_dot_g) && gpu_p_dot_g < 0.0,
        "production CUDA NCG PR+ direction must retain the heterogeneous-Ms descent product");

    const double initial_step =
        fullmag::fem::relaxation::initial_step_from_volume_norm_sq(
            expected_direction_volume_norm_sq, default_step, min_step, max_step);
    const double expected_initial_step = std::min(
        std::clamp(default_step, min_step, max_step),
        std::clamp(
            1.0 / std::sqrt(expected_direction_volume_norm_sq), min_step, max_step));
    check(
        initial_step == expected_initial_step,
        "production CUDA NCG initial-step helper must match the independent volume-norm oracle");
    const double current_energy = 1.0e-20;
    const double monotone_trial_energy = std::nextafter(
        current_energy, -std::numeric_limits<double>::infinity());
    const double increasing_trial_energy = std::nextafter(
        current_energy, std::numeric_limits<double>::infinity());
    check(
        fullmag::fem::relaxation::strict_monotone_energy_accept(
            current_energy, monotone_trial_energy) ==
                (std::isfinite(current_energy) &&
                    std::isfinite(monotone_trial_energy) &&
                    monotone_trial_energy <= current_energy) &&
            fullmag::fem::relaxation::strict_monotone_energy_accept(
                current_energy, increasing_trial_energy) ==
                (std::isfinite(current_energy) &&
                    std::isfinite(increasing_trial_energy) &&
                    increasing_trial_energy <= current_energy),
        "production CUDA NCG strict Armijo-recovery helper must match the independent finite monotonicity oracle");

    for (void *pointer : {
             static_cast<void *>(d_previous_x), static_cast<void *>(d_previous_y),
             static_cast<void *>(d_previous_z), static_cast<void *>(d_trial_x),
             static_cast<void *>(d_trial_y), static_cast<void *>(d_trial_z),
             static_cast<void *>(d_previous_gx), static_cast<void *>(d_previous_gy),
             static_cast<void *>(d_previous_gz), static_cast<void *>(d_trial_gx),
             static_cast<void *>(d_trial_gy), static_cast<void *>(d_trial_gz),
             static_cast<void *>(d_ms), static_cast<void *>(d_volume),
             static_cast<void *>(d_mask), static_cast<void *>(d_ss),
             static_cast<void *>(d_sy), static_cast<void *>(d_yy),
             static_cast<void *>(d_ncg_hx), static_cast<void *>(d_ncg_hy),
             static_cast<void *>(d_ncg_hz), static_cast<void *>(d_previous_px),
             static_cast<void *>(d_previous_py), static_cast<void *>(d_previous_pz),
             static_cast<void *>(d_next_px), static_cast<void *>(d_next_py),
             static_cast<void *>(d_next_pz)}) {
        cudaFree(pointer);
    }
}
#endif

} // namespace

int main()
{
    analytic_absolute_term_sum_resolves_component_cancellation();
    cpu_energy_weight_uses_nodal_ms_and_uniform_fallback();
    dimension_aware_reduction_guards_are_scale_relative();
    strict_monotone_energy_scale_sweep();
    std::vector<std::string> failed_interactions;
    for (Interaction interaction : {
             Interaction::Exchange,
             Interaction::Zeeman,
             Interaction::Pma,
             Interaction::Cubic,
             Interaction::Dmi,
             Interaction::Demag,
             Interaction::Magnetoelastic,
         }) {
        if (!check_interaction_directional_derivative(interaction)) {
            failed_interactions.emplace_back(interaction_name(interaction));
        }
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    cuda_heterogeneous_nodal_ms_pgbb_ncg_calibration();
#endif
    check(
        failed_interactions.empty(),
        "native field-energy directional derivative failures: " +
            (failed_interactions.empty() ? std::string("none") : failed_interactions.front()));
    std::puts("PASS: FEM relaxation energy derivative matrix");
    return 0;
}

/* Real native field/energy directional-derivative contract for FEM Armijo. */

#include "fullmag_fem.h"

#include "context.hpp"
#include "cpu/mfem/interactions/demag_poisson_energy.hpp"
#include "cpu/mfem/interactions/anisotropy_uniaxial.hpp"
#include "cpu/mfem/interactions/exchange_energy_difference.hpp"
#include "cpu/mfem/interactions/zeeman_energy.hpp"
#include "cpu/mfem/relaxation/relaxation_math.hpp"
#include "cpu/mfem/runtime/aos_field.hpp"
#include "fem_common.hpp"
#include "src/relaxation_numerics.hpp"
#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif
#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/exchange/exchange_kernels.hpp"
#include "gpu/cuda/interactions/dmi/dmi_kernels.hpp"
#include "gpu/cuda/relaxation/direct_energy_increment.hpp"
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

void term_complete_composition_preserves_endpoint_operand_uncertainty()
{
    using fullmag::fem::relaxation::ArmijoDifferenceDecision;
    using fullmag::fem::relaxation::compose_term_complete_energy_difference;
    using fullmag::fem::relaxation::reduction_roundoff_bound;
    using fullmag::fem::relaxation::strict_armijo_difference_decision;

    const double endpoint_total = -2.0e-17;
    const double exchange_direct = -2.1037518401e-39;
    const double zeeman_direct = 7.9035597018e-49;
    const auto difference = compose_term_complete_energy_difference(
        0.0,
        0.0,
        exchange_direct + zeeman_direct,
        std::abs(exchange_direct) + std::abs(zeeman_direct),
        96u);
    check(
        difference.delta_joules < -2.103751e-39,
        "term-complete composition must retain the descending exchange increment");
    check(
        strict_armijo_difference_decision(difference, -6.0314e-43) ==
            ArmijoDifferenceDecision::Accept,
        "retained GPU exchange-plus-Zeeman failure components must satisfy strict Armijo");

    const double endpoint_residual_operand_absolute_sum =
        2.0 * std::abs(endpoint_total);
    const auto residual = compose_term_complete_energy_difference(
        0.0,
        endpoint_residual_operand_absolute_sum,
        zeeman_direct,
        std::abs(zeeman_direct),
        96u);
    const double endpoint_ulp = std::abs(
        std::nextafter(endpoint_total, std::numeric_limits<double>::infinity()) -
        endpoint_total);
    check(
        residual.absolute_term_sum_joules >=
            endpoint_residual_operand_absolute_sum,
        "term-complete composition must retain the endpoint operands in its absolute scale");
    check(
        residual.roundoff_bound_joules >=
            reduction_roundoff_bound(96u) *
                endpoint_residual_operand_absolute_sum &&
            residual.roundoff_bound_joules > endpoint_ulp &&
            residual.roundoff_bound_joules > 1.0e-33,
        "endpoint residual operand scale must produce a conservative subtraction bound");

    const auto uphill = compose_term_complete_energy_difference(
        0.0,
        0.0,
        zeeman_direct,
        std::abs(zeeman_direct),
        96u);
    check(
        strict_armijo_difference_decision(uphill, -5.0e-49) ==
            ArmijoDifferenceDecision::Reject,
        "term-complete composition must reject a resolved uphill increment");
}

void adverse_drive_endpoint_delta_controls_strict_armijo()
{
    using fullmag::fem::relaxation::ArmijoDifferenceDecision;
    using fullmag::fem::relaxation::compose_term_complete_energy_difference;
    using fullmag::fem::relaxation::strict_armijo_difference_decision;

    const double direct_decrement = -4.0e-31;
    const double adverse_drive_delta = 7.0e-31;
    const double drive_base = -1.1e-17;
    const double drive_trial = drive_base + adverse_drive_delta;
    const auto complete = compose_term_complete_energy_difference(
        drive_trial - drive_base,
        std::abs(drive_base) + std::abs(drive_trial),
        direct_decrement,
        std::abs(direct_decrement),
        2u);
    const auto omitted = compose_term_complete_energy_difference(
        0.0,
        0.0,
        direct_decrement,
        std::abs(direct_decrement),
        1u);

    check(
        strict_armijo_difference_decision(omitted, -2.0e-31) ==
            ArmijoDifferenceDecision::Accept,
        "drive omission fixture must otherwise satisfy strict Armijo");
    check(
        strict_armijo_difference_decision(complete, -2.0e-31) ==
            ArmijoDifferenceDecision::Reject,
        "an adverse regional-drive endpoint delta must make strict Armijo reject");
}

struct PolarizedExchangeOracle {
    long double value = 0.0L;
    long double absolute_term_sum = 0.0L;
    std::vector<double> difference;
    std::vector<double> applied_sum;
};

PolarizedExchangeOracle polarized_exchange_long_double_oracle(
    const std::vector<std::vector<long double>> &matrix,
    const std::vector<double> &base,
    const std::vector<double> &trial)
{
    check(
        !matrix.empty() && matrix.size() == base.size() &&
            trial.size() == base.size(),
        "polarized exchange oracle dimensions must agree");
    PolarizedExchangeOracle oracle;
    oracle.difference.resize(base.size());
    oracle.applied_sum.resize(base.size());
    for (size_t row = 0; row < matrix.size(); ++row) {
        check(
            matrix[row].size() == matrix.size(),
            "polarized exchange oracle matrix must be square");
        const long double difference =
            static_cast<long double>(trial[row]) -
            static_cast<long double>(base[row]);
        long double applied_sum = 0.0L;
        for (size_t column = 0; column < matrix.size(); ++column) {
            applied_sum += matrix[row][column] *
                (static_cast<long double>(trial[column]) +
                 static_cast<long double>(base[column]));
        }
        const long double term = difference * applied_sum;
        oracle.value += term;
        oracle.absolute_term_sum += std::abs(term);
        oracle.difference[row] = static_cast<double>(difference);
        oracle.applied_sum[row] = static_cast<double>(applied_sum);
    }
    return oracle;
}

long double quadratic_energy_long_double(
    const std::vector<std::vector<long double>> &matrix,
    const std::vector<double> &state)
{
    long double energy = 0.0L;
    for (size_t row = 0; row < matrix.size(); ++row) {
        long double applied = 0.0L;
        for (size_t column = 0; column < matrix.size(); ++column) {
            applied += matrix[row][column] *
                static_cast<long double>(state[column]);
        }
        energy += static_cast<long double>(state[row]) * applied;
    }
    return energy;
}

void polarized_exchange_difference_matches_long_double_and_endpoint_oracles()
{
    using fullmag::fem::polarized_exchange_difference_from_applied_sum;

    const std::vector<std::vector<long double>> matrix = {
        {2.0L, -1.0L, 0.0L},
        {-1.0L, 2.0L, -1.0L},
        {0.0L, -1.0L, 1.0L},
    };
    const std::vector<double> base = {0.25, -0.5, 0.75};
    const std::vector<double> trial = {0.375, -0.25, 0.625};
    const auto oracle = polarized_exchange_long_double_oracle(
        matrix, base, trial);
    const auto actual = polarized_exchange_difference_from_applied_sum(
        oracle.difference.data(), oracle.applied_sum.data(), oracle.difference.size());
    const long double endpoint_delta =
        quadratic_energy_long_double(matrix, trial) -
        quadratic_energy_long_double(matrix, base);
    const long double tolerance =
        8.0L * static_cast<long double>(std::numeric_limits<double>::epsilon()) *
        std::max(1.0L, oracle.absolute_term_sum);
    check(
        std::abs(static_cast<long double>(actual.delta_joules) - oracle.value) <=
            tolerance,
        "production polarized exchange accumulation must match its long-double oracle");
    check(
        std::abs(static_cast<long double>(actual.absolute_term_sum_joules) -
                 oracle.absolute_term_sum) <= tolerance,
        "production polarized exchange accumulation must retain the long-double absolute-term sum");
    check(
        std::abs(static_cast<long double>(actual.delta_joules) - endpoint_delta) <=
            tolerance,
        "polarized exchange difference must match m^T K_A m endpoint subtraction at resolvable scale");

    const std::vector<std::vector<long double>> near_nullspace_matrix = {
        {1.0L, 0.0L},
        {0.0L, 1.0e-12L},
    };
    const std::vector<double> near_nullspace_base = {1.0, 1.0e-3};
    const std::vector<double> near_nullspace_trial = {1.0, 1.0e-3 - 1.0e-9};
    const auto near_nullspace = polarized_exchange_long_double_oracle(
        near_nullspace_matrix, near_nullspace_base, near_nullspace_trial);
    const double endpoint_base = static_cast<double>(
        quadratic_energy_long_double(near_nullspace_matrix, near_nullspace_base));
    const double endpoint_trial = static_cast<double>(
        quadratic_energy_long_double(near_nullspace_matrix, near_nullspace_trial));
    check(
        endpoint_trial == endpoint_base,
        "near-nullspace fixture must hide its decrement in binary64 endpoint energies");
    const auto retained = polarized_exchange_difference_from_applied_sum(
        near_nullspace.difference.data(),
        near_nullspace.applied_sum.data(),
        near_nullspace.difference.size());
    check(
        near_nullspace.value < 0.0L && retained.delta_joules < 0.0 &&
            std::isfinite(retained.delta_joules),
        "production polarized exchange accumulation must retain a finite negative near-nullspace increment");

    const double nonfinite[] = {std::numeric_limits<double>::quiet_NaN()};
    const auto invalid = polarized_exchange_difference_from_applied_sum(
        nonfinite, nonfinite, 1u);
    check(
        std::isnan(invalid.delta_joules) &&
            std::isnan(invalid.absolute_term_sum_joules) &&
            std::isnan(invalid.roundoff_bound_joules),
        "production polarized exchange accumulation must fail closed on non-finite terms");
}

#if FULLMAG_HAS_MFEM_STACK
mfem::Mesh magnetic_and_air_exchange_mesh()
{
    mfem::Mesh mesh(3, 8, 2, 0, 3);
    const double vertices[][3] = {
        {0.0, 0.0, 0.0}, {1.0, 0.0, 0.0}, {0.0, 1.0, 0.0}, {0.0, 0.0, 1.0},
        {2.0, 0.0, 0.0}, {3.0, 0.0, 0.0}, {2.0, 1.0, 0.0}, {2.0, 0.0, 1.0},
    };
    for (const auto &vertex : vertices) {
        mesh.AddVertex(vertex);
    }
    const int magnetic[] = {0, 1, 2, 3};
    const int air[] = {4, 5, 6, 7};
    mesh.AddTet(magnetic, 1);
    mesh.AddTet(air, 2);
    mesh.FinalizeTopology();
    mesh.Finalize(false, true);
    return mesh;
}

long double exchange_endpoint_energy(
    mfem::BilinearForm &form,
    const std::vector<double> &state,
    std::size_t component)
{
    const int nodes = form.FESpace()->GetNDofs();
    mfem::Vector component_state(nodes);
    for (int node = 0; node < nodes; ++node) {
        component_state[node] = state[3u * static_cast<std::size_t>(node) + component];
    }
    mfem::Vector applied(nodes);
    form.Mult(component_state, applied);
    long double energy = 0.0L;
    for (int node = 0; node < nodes; ++node) {
        energy += static_cast<long double>(component_state[node]) *
            static_cast<long double>(applied[node]);
    }
    return energy;
}

long double exchange_endpoint_difference(
    mfem::BilinearForm &form,
    const std::vector<double> &base,
    const std::vector<double> &trial)
{
    long double difference = 0.0L;
    for (std::size_t component = 0; component < 3u; ++component) {
        difference += exchange_endpoint_energy(form, trial, component) -
            exchange_endpoint_energy(form, base, component);
    }
    return difference;
}

void production_exchange_energy_difference_uses_assembled_mfem_form()
{
    mfem::Mesh mesh = magnetic_and_air_exchange_mesh();
    mfem::H1_FECollection collection(1, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    mfem::ConstantCoefficient stiffness(1.3e-11);
    mfem::Array<int> magnetic_marker(mesh.attributes.Max());
    magnetic_marker = 0;
    magnetic_marker[0] = 1;
    mfem::BilinearForm magnetic_form(&space);
    magnetic_form.AddDomainIntegrator(
        new mfem::DiffusionIntegrator(stiffness), magnetic_marker);
    magnetic_form.Assemble();
    magnetic_form.Finalize();

    mfem::BilinearForm all_domain_form(&space);
    all_domain_form.AddDomainIntegrator(new mfem::DiffusionIntegrator(stiffness));
    all_domain_form.Assemble();
    all_domain_form.Finalize();

    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = static_cast<uint32_t>(space.GetNDofs());
    ctx.mesh.magnetic_node_mask.assign(ctx.mesh.n_nodes, 0u);
    for (std::size_t node = 0; node < 4u; ++node) {
        ctx.mesh.magnetic_node_mask[node] = 1u;
    }
    ctx.exchange.enabled = true;
    ctx.exchange.mfem.exchange_form = &magnetic_form;
    ctx.mfem_context.ready = true;

    std::vector<double> base(3u * ctx.mesh.n_nodes, 0.0);
    std::vector<double> trial(3u * ctx.mesh.n_nodes, 0.0);
    for (std::size_t node = 0; node < ctx.mesh.n_nodes; ++node) {
        base[3u * node + 0u] = 0.11 + 0.07 * static_cast<double>(node);
        base[3u * node + 1u] = -0.23 + 0.03 * static_cast<double>(node);
        base[3u * node + 2u] = 0.37 - 0.02 * static_cast<double>(node);
        trial[3u * node + 0u] = base[3u * node + 0u] + 0.013 * static_cast<double>(node + 1u);
        trial[3u * node + 1u] = base[3u * node + 1u] - 0.009 * static_cast<double>(node + 2u);
        trial[3u * node + 2u] = base[3u * node + 2u] + 0.005 * static_cast<double>(2u * node + 1u);
    }

    std::string error;
    const auto actual = fullmag::fem::exchange_energy_difference(
        ctx, base, trial, false, error);
    const long double endpoint = exchange_endpoint_difference(
        magnetic_form, base, trial);
    const long double scale = std::max(1.0e-40L, std::abs(endpoint));
    check(error.empty(), "production exchange difference must accept the assembled MFEM form");
    check(
        std::abs(static_cast<long double>(actual.delta_joules) - endpoint) <=
            64.0L * static_cast<long double>(std::numeric_limits<double>::epsilon()) * scale,
        "production exchange difference must preserve AoS component-to-MFEM-DOF mapping against endpoint energy");
    check(
        std::abs(exchange_endpoint_difference(all_domain_form, base, trial) - endpoint) >
            1.0e-18L * scale,
        "magnetic-marker form selection must observably exclude the nonmagnetic tetrahedron");

    std::vector<double> air_changed_base = base;
    std::vector<double> air_changed_trial = trial;
    for (std::size_t node = 4u; node < ctx.mesh.n_nodes; ++node) {
        for (std::size_t component = 0; component < 3u; ++component) {
            air_changed_base[3u * node + component] += 1.0e6 * static_cast<double>(node + component + 1u);
            air_changed_trial[3u * node + component] -= 2.0e6 * static_cast<double>(node + component + 1u);
        }
    }
    const auto air_changed = fullmag::fem::exchange_energy_difference(
        ctx, air_changed_base, air_changed_trial, false, error);
    check(
        error.empty() && air_changed.delta_joules == actual.delta_joules,
        "production exchange difference must ignore magnetization changes confined to the nonmagnetic domain");

    ctx.mesh.periodic_reduced_node.resize(ctx.mesh.n_nodes);
    ctx.mesh.periodic_representative_nodes.resize(ctx.mesh.n_nodes);
    for (uint32_t node = 0; node < ctx.mesh.n_nodes; ++node) {
        ctx.mesh.periodic_reduced_node[node] = node;
        ctx.mesh.periodic_representative_nodes[node] = node;
    }
    ctx.mesh.periodic_reduced_node[1] = 0u;
    auto periodic_base = base;
    auto periodic_trial = trial;
    fullmag::fem::project_static_periodic_aos(ctx, periodic_base);
    fullmag::fem::project_static_periodic_aos(ctx, periodic_trial);
    const auto periodic_actual = fullmag::fem::exchange_energy_difference(
        ctx, periodic_base, periodic_trial, false, error);
    const long double periodic_endpoint = exchange_endpoint_difference(
        magnetic_form, periodic_base, periodic_trial);
    const long double periodic_scale =
        std::max(1.0e-40L, std::abs(periodic_endpoint));
    check(
        error.empty() &&
            std::abs(
                static_cast<long double>(periodic_actual.delta_joules) -
                periodic_endpoint) <=
                64.0L * static_cast<long double>(std::numeric_limits<double>::epsilon()) *
                    periodic_scale,
        "production exchange difference must preserve endpoint identity for static-periodic class-projected states");
}
#endif

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

void direct_armijo_difference_resolves_sub_ulp_total_energy_decrement()
{
    using fullmag::fem::relaxation::ArmijoDifferenceDecision;
    using fullmag::fem::relaxation::EnergyDifference;
    using fullmag::fem::relaxation::strict_armijo_difference_decision;

    const double current_total_energy = -2.0e-17;
    const double direct_delta_energy = -1.0e-34;
    const double trial_total_energy = current_total_energy + direct_delta_energy;
    check(
        trial_total_energy == current_total_energy,
        "manufactured Armijo fixture must hide its physical decrement in endpoint total-energy binary64 rounding");

    const EnergyDifference resolved = {
        direct_delta_energy,
        std::abs(direct_delta_energy),
        0.0,
    };
    check(
        strict_armijo_difference_decision(resolved, -5.0e-35) ==
            ArmijoDifferenceDecision::Accept,
        "direct Armijo difference must accept a resolved descending sub-ULP endpoint decrement");

    const EnergyDifference ambiguous = {
        -8.0e-35,
        1.0e-34,
        4.0e-35,
    };
    check(
        strict_armijo_difference_decision(ambiguous, -5.0e-35) ==
            ArmijoDifferenceDecision::Refine,
        "an Armijo threshold inside the direct-difference uncertainty interval must request refinement");

    const EnergyDifference refined = {
        -9.0e-35,
        1.0e-34,
        1.0e-35,
    };
    check(
        strict_armijo_difference_refinement_accepts(
            ambiguous, refined, -5.0e-35),
        "an ambiguous ordinary difference may pass only when its nominal decrement and an independently refined difference both satisfy Armijo");
    const EnergyDifference refined_rejection = {
        -4.0e-35,
        1.0e-34,
        1.0e-35,
    };
    check(
        !strict_armijo_difference_refinement_accepts(
            ambiguous, refined_rejection, -5.0e-35),
        "a refinement that does not resolve strict Armijo must reject the trial");

    const EnergyDifference uphill = {
        1.0e-34,
        1.0e-34,
        0.0,
    };
    check(
        strict_armijo_difference_decision(uphill, -5.0e-35) ==
            ArmijoDifferenceDecision::Reject,
        "direct Armijo difference must reject a resolved uphill trial");
}

void polarized_demag_energy_difference_uses_endpoint_fields()
{
    fullmag::fem::Context ctx;
    ctx.mesh.magnetic_node_mask = {1u, 0u};
    ctx.integration_weights.mfem_lumped_mass = {2.0e-27, 9.0e-27};
    ctx.material_fields.Ms_field = {4.0e5, 7.0e5};
    const std::vector<double> current_m = {1.0, 0.0, 0.0, 1.0e6, -2.0e6, 3.0e6};
    const std::vector<double> trial_m = {1.0 - 2.0e-12, 3.0e-12, -5.0e-12,
                                         -4.0e6, 5.0e6, -6.0e6};
    const std::vector<double> current_h = {-3.0e4, 2.0e4, 1.0e4,
                                            8.0e9, -9.0e9, 1.0e10};
    const std::vector<double> trial_h = {-3.0e4 + 7.0e-8, 2.0e4 - 11.0e-8,
                                          1.0e4 + 13.0e-8,
                                          -1.0e10, 2.0e10, -3.0e10};
    const auto difference = fullmag::fem::demag_poisson_energy_difference_from_endpoint_fields(
        ctx, current_m, trial_m, current_h, trial_h);
    const double dx = trial_m[0] - current_m[0];
    const double dy = trial_m[1] - current_m[1];
    const double dz = trial_m[2] - current_m[2];
    const double expected = -0.5 * fullmag::fem::kMu0 * 4.0e5 * 2.0e-27 *
        (dx * (current_h[0] + trial_h[0]) +
         dy * (current_h[1] + trial_h[1]) +
         dz * (current_h[2] + trial_h[2]));
    check(
        std::abs(difference.delta_joules - expected) <= 1.0e-45,
        "polarized demag difference must use only active endpoint fields with -0.5 mu0 Ms V");
    check(
        difference.absolute_term_sum_joules >= std::abs(expected),
        "polarized demag difference must expose an absolute term sum for roundoff bounds");
}

void polarized_robin_boundary_energy_difference_uses_endpoint_potentials()
{
    const std::vector<double> current_u = {1.0, -2.0};
    const std::vector<double> trial_u = {1.5, -1.0};
    // M_Gamma = [[2, 1], [1, 3]].
    const std::vector<double> current_boundary_product = {0.0, -5.0};
    const std::vector<double> trial_boundary_product = {2.0, -1.5};
    constexpr double coefficient = 3.0;
    const auto difference =
        fullmag::fem::robin_boundary_energy_difference_from_endpoint_products(
            coefficient,
            current_u,
            trial_u,
            current_boundary_product,
            trial_boundary_product);
    const double current_energy = 0.5 * coefficient * 10.0;
    const double trial_energy = 0.5 * coefficient * 4.5;
    check(
        std::abs(difference.delta_joules - (trial_energy - current_energy)) < 1.0e-14,
        "polarized Robin boundary increment must equal the endpoint quadratic-energy difference");
    check(
        difference.absolute_term_sum_joules > std::abs(difference.delta_joules) &&
            difference.roundoff_bound_joules > 0.0,
        "Robin increment must retain a cancellation-aware absolute-term sum and roundoff bound");
}

void direct_zeeman_energy_difference_avoids_endpoint_total_subtraction()
{
    fullmag::fem::Context ctx;
    ctx.mesh.magnetic_node_mask = {1u};
    ctx.integration_weights.mfem_lumped_mass = {3.0e-27};
    ctx.material_fields.Ms_field = {8.0e5};
    ctx.zeeman.has_external_field = true;
    ctx.zeeman.h_ext_xyz = {2.0e5, -3.0e5, 5.0e5};
    const std::vector<double> current_m = {1.0, 0.0, 0.0};
    const std::vector<double> trial_m = {1.0 - 2.0e-12, 3.0e-12, -5.0e-12};
    const auto difference =
        fullmag::fem::zeeman_energy_difference_from_field(ctx, current_m, trial_m);
    const double expected = -fullmag::fem::kMu0 * 8.0e5 * 3.0e-27 *
        ((trial_m[0] - current_m[0]) * 2.0e5 +
         (trial_m[1] - current_m[1]) * -3.0e5 +
         (trial_m[2] - current_m[2]) * 5.0e5);
    check(
        std::abs(difference.delta_joules - expected) <= 1.0e-45,
        "direct Zeeman difference must evaluate the nodal magnetization increment before reduction");
}

void direct_uniaxial_energy_difference_uses_local_density_difference()
{
    fullmag::fem::Context ctx;
    ctx.mesh.magnetic_node_mask = {1u};
    ctx.integration_weights.mfem_lumped_mass = {4.0e-27};
    ctx.anisotropy.uniaxial_enabled = true;
    ctx.anisotropy.uniaxial_Ku = 2.0e5;
    ctx.anisotropy.uniaxial_Ku2 = 3.0e4;
    ctx.anisotropy.uniaxial_axis = {0.0, 0.0, 1.0};
    const std::vector<double> current_m = {0.6, 0.0, 0.8};
    const std::vector<double> trial_m = {0.6, 0.0, 0.8 - 2.0e-12};
    const auto difference = fullmag::fem::uniaxial_anisotropy_energy_difference(
        ctx, current_m, trial_m);
    const double q0 = current_m[2];
    const double q1 = trial_m[2];
    const double expected = 4.0e-27 *
        (-2.0e5 * (q1 * q1 - q0 * q0) -
         3.0e4 * (q1 * q1 * q1 * q1 - q0 * q0 * q0 * q0));
    check(
        std::abs(difference.delta_joules - expected) <= 1.0e-45,
        "direct uniaxial difference must subtract local energy densities before reduction");
}

void transported_bb_secant_lives_in_the_accepted_tangent_space()
{
    fullmag::fem::Context ctx;
    ctx.mesh.magnetic_node_mask = {1u};
    const double inv_sqrt_two = 1.0 / std::sqrt(2.0);
    const std::vector<double> previous_m = {1.0, 0.0, 0.0};
    const std::vector<double> accepted_m = {inv_sqrt_two, inv_sqrt_two, 0.0};
    const std::vector<double> previous_g = {0.0, 2.0, 1.0};
    const std::vector<double> accepted_g = {
        -3.0 * inv_sqrt_two, 3.0 * inv_sqrt_two, 1.0};
    std::vector<double> transported_s;
    std::vector<double> transported_y;

    check(
        fullmag::fem::relaxation::transported_bb_secant(
            ctx,
            previous_m,
            accepted_m,
            previous_g,
            accepted_g,
            transported_s,
            transported_y),
        "transported BB secant must accept a conforming nodal-sphere state");

    const auto dot = [](const std::vector<double> &a, const std::vector<double> &b) {
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    };
    const std::vector<double> ambient_s = {
        accepted_m[0] - previous_m[0],
        accepted_m[1] - previous_m[1],
        accepted_m[2] - previous_m[2],
    };
    check(
        std::abs(dot(accepted_m, ambient_s)) > 1.0e-3,
        "manufactured state must distinguish ambient and accepted-tangent BB steps");
    check(
        std::abs(dot(accepted_m, transported_s)) <=
            32.0 * std::numeric_limits<double>::epsilon(),
        "transported BB step must be tangent at the accepted magnetization");
    check(
        std::abs(dot(accepted_m, transported_y)) <=
            64.0 * std::numeric_limits<double>::epsilon(),
        "transported BB gradient difference must be tangent at the accepted magnetization");
}

#if FULLMAG_HAS_CUDA_RUNTIME
void gpu_energy_increment_ownership_is_context_derived_and_exhaustive()
{
    using fullmag::fem::GpuEnergyIncrementOwner;
    using fullmag::fem::GpuFinalScalarSlot;
    using fullmag::fem::gpu_energy_increment_owner;

    fullmag::fem::Context enabled;
    enabled.exchange.enabled = true;
    enabled.demag.enabled = true;
    enabled.zeeman.has_external_field = true;
    enabled.zeeman.regional_drives.emplace_back();
    enabled.anisotropy.uniaxial_enabled = true;
    enabled.anisotropy.cubic_enabled = true;
    enabled.dmi.interfacial_enabled = true;
    enabled.dmi.bulk_enabled = true;
    enabled.magnetoelastic.enabled = true;

    for (int raw = 0; raw < static_cast<int>(GpuFinalScalarSlot::Count); ++raw) {
        check(
            gpu_energy_increment_owner(
                enabled, static_cast<GpuFinalScalarSlot>(raw)) !=
                GpuEnergyIncrementOwner::Unsupported,
            "every current GPU final scalar slot must have an explicit Armijo owner");
    }
    check(
        gpu_energy_increment_owner(enabled, GpuFinalScalarSlot::ExchangeEnergy) ==
                GpuEnergyIncrementOwner::Direct &&
            gpu_energy_increment_owner(enabled, GpuFinalScalarSlot::DemagEnergy) ==
                GpuEnergyIncrementOwner::Direct &&
            gpu_energy_increment_owner(enabled, GpuFinalScalarSlot::ExternalEnergy) ==
                GpuEnergyIncrementOwner::Direct &&
            gpu_energy_increment_owner(enabled, GpuFinalScalarSlot::AnisotropyEnergy) ==
                GpuEnergyIncrementOwner::Direct &&
            gpu_energy_increment_owner(enabled, GpuFinalScalarSlot::DmiEnergy) ==
                GpuEnergyIncrementOwner::Direct &&
            gpu_energy_increment_owner(enabled, GpuFinalScalarSlot::BulkDmiEnergy) ==
                GpuEnergyIncrementOwner::Direct,
        "qualified CUDA exchange, demag, external, uniaxial, and DMI terms must be direct exactly once");
    check(
        gpu_energy_increment_owner(enabled, GpuFinalScalarSlot::DriveEnergy) ==
                GpuEnergyIncrementOwner::EndpointResidual &&
            gpu_energy_increment_owner(
                enabled, GpuFinalScalarSlot::CubicAnisotropyEnergy) ==
                GpuEnergyIncrementOwner::EndpointResidual &&
            gpu_energy_increment_owner(
                enabled, GpuFinalScalarSlot::MagnetoelasticEnergy) ==
                GpuEnergyIncrementOwner::EndpointResidual,
        "drive, cubic, and magnetoelastic terms without qualified CUDA direct owners must use explicit endpoint residuals");
    check(
        gpu_energy_increment_owner(
            enabled, GpuFinalScalarSlot::DemagRobinBoundaryEnergy) ==
            GpuEnergyIncrementOwner::NotEnergy,
        "Robin boundary diagnostics must not double-count the polarized demag energy");
    for (GpuFinalScalarSlot observable : {
             GpuFinalScalarSlot::MaxRhs,
             GpuFinalScalarSlot::MaxHEff,
             GpuFinalScalarSlot::MaxHDemag,
             GpuFinalScalarSlot::MaxTorque,
             GpuFinalScalarSlot::MxSum,
             GpuFinalScalarSlot::MySum,
             GpuFinalScalarSlot::MzSum,
             GpuFinalScalarSlot::MomentWeight,
         }) {
        check(
            gpu_energy_increment_owner(enabled, observable) ==
                GpuEnergyIncrementOwner::NotEnergy,
            "GPU final observables must not participate in Armijo energy composition");
    }

    fullmag::fem::Context disabled;
    disabled.exchange.enabled = false;
    for (GpuFinalScalarSlot energy : {
             GpuFinalScalarSlot::ExchangeEnergy,
             GpuFinalScalarSlot::DemagEnergy,
             GpuFinalScalarSlot::ExternalEnergy,
             GpuFinalScalarSlot::DriveEnergy,
             GpuFinalScalarSlot::DmiEnergy,
             GpuFinalScalarSlot::BulkDmiEnergy,
             GpuFinalScalarSlot::AnisotropyEnergy,
             GpuFinalScalarSlot::CubicAnisotropyEnergy,
             GpuFinalScalarSlot::MagnetoelasticEnergy,
         }) {
        check(
            gpu_energy_increment_owner(disabled, energy) ==
                GpuEnergyIncrementOwner::NotEnergy,
            "disabled GPU energies must be excluded by Context state");
    }
    check(
        gpu_energy_increment_owner(disabled, GpuFinalScalarSlot::Count) ==
            GpuEnergyIncrementOwner::Unsupported,
        "an unknown GPU scalar semantic must fail closed as unsupported");
}

void gpu_term_complete_composition_retains_direct_zeeman_failure_scale()
{
    using fullmag::fem::GpuDirectEnergySnapshot;
    using fullmag::fem::GpuFinalScalarSlot;

    fullmag::fem::Context ctx;
    ctx.exchange.enabled = true;
    ctx.zeeman.has_external_field = true;
    GpuDirectEnergySnapshot base{};
    GpuDirectEnergySnapshot trial{};
    base.total_energy_j = -2.0e-17;
    trial.total_energy_j = -2.0e-17;
    base.terms_j[static_cast<size_t>(GpuFinalScalarSlot::DemagRobinBoundaryEnergy)] =
        -7.0e-12;
    trial.terms_j[static_cast<size_t>(GpuFinalScalarSlot::DemagRobinBoundaryEnergy)] =
        9.0e-12;
    base.terms_j[static_cast<size_t>(GpuFinalScalarSlot::DriveEnergy)] = -1.0e9;
    trial.terms_j[static_cast<size_t>(GpuFinalScalarSlot::DriveEnergy)] = 1.0e9;

    constexpr double exchange_delta = -2.1037518401e-39;
    constexpr double zeeman_delta = 7.9035597018e-49;
    fullmag::fem::relaxation::EnergyDifference difference{};
    double endpoint_residual_delta = 0.0;
    double endpoint_residual_operand_absolute_sum = 0.0;
    std::string error;
    check(
        fullmag::fem::gpu_compose_term_complete_energy_difference(
            ctx,
            base,
            trial,
            exchange_delta + zeeman_delta,
            std::abs(exchange_delta) + std::abs(zeeman_delta),
            96u,
            difference,
            endpoint_residual_delta,
            endpoint_residual_operand_absolute_sum,
            error),
        "GPU term-complete composition must accept classified direct inputs: " +
            error);
    check(
        difference.delta_joules == exchange_delta + zeeman_delta &&
            endpoint_residual_delta == 0.0 &&
            endpoint_residual_operand_absolute_sum == 0.0,
        "GPU Armijo composition must retain direct exchange plus Zeeman without endpoint-total reconstruction or disabled-scalar inference");
    check(
        fullmag::fem::relaxation::strict_armijo_difference_decision(
            difference, -6.0314e-43) ==
            fullmag::fem::relaxation::ArmijoDifferenceDecision::Accept,
        "retained GPU exchange-plus-Zeeman increment must satisfy strict Armijo");

    fullmag::fem::Context disabled_ctx;
    disabled_ctx.exchange.enabled = false;
    GpuDirectEnergySnapshot disabled_base{};
    GpuDirectEnergySnapshot disabled_trial{};
    for (GpuFinalScalarSlot disabled_slot : {
             GpuFinalScalarSlot::ExchangeEnergy,
             GpuFinalScalarSlot::DemagEnergy,
             GpuFinalScalarSlot::DemagRobinBoundaryEnergy,
             GpuFinalScalarSlot::ExternalEnergy,
             GpuFinalScalarSlot::DriveEnergy,
             GpuFinalScalarSlot::DmiEnergy,
             GpuFinalScalarSlot::BulkDmiEnergy,
             GpuFinalScalarSlot::AnisotropyEnergy,
             GpuFinalScalarSlot::CubicAnisotropyEnergy,
             GpuFinalScalarSlot::MagnetoelasticEnergy,
         }) {
        disabled_base.terms_j[static_cast<size_t>(disabled_slot)] = -1.0e9;
        disabled_trial.terms_j[static_cast<size_t>(disabled_slot)] = 1.0e9;
    }
    check(
        fullmag::fem::gpu_compose_term_complete_energy_difference(
            disabled_ctx,
            disabled_base,
            disabled_trial,
            0.0,
            0.0,
            96u,
            difference,
            endpoint_residual_delta,
            endpoint_residual_operand_absolute_sum,
            error) &&
            difference.delta_joules == 0.0 &&
            difference.absolute_term_sum_joules == 0.0,
        "disabled energy slots must remain excluded even when their stored scalars are nonzero");

    fullmag::fem::Context residual_ctx;
    residual_ctx.exchange.enabled = false;
    residual_ctx.zeeman.regional_drives.emplace_back();
    residual_ctx.anisotropy.cubic_enabled = true;
    residual_ctx.magnetoelastic.enabled = true;
    GpuDirectEnergySnapshot residual_base{};
    GpuDirectEnergySnapshot residual_trial{};
    const auto set_pair = [&](GpuFinalScalarSlot slot, double base_value,
                              double trial_value) {
        residual_base.terms_j[static_cast<size_t>(slot)] = base_value;
        residual_trial.terms_j[static_cast<size_t>(slot)] = trial_value;
    };
    set_pair(GpuFinalScalarSlot::DriveEnergy, -1.1e-17, -1.1e-17 + 7.0e-31);
    set_pair(
        GpuFinalScalarSlot::CubicAnisotropyEnergy,
        3.0e-18,
        3.0e-18 - 2.0e-31);
    set_pair(
        GpuFinalScalarSlot::MagnetoelasticEnergy,
        -4.0e-18,
        -4.0e-18 + 5.0e-31);
    set_pair(GpuFinalScalarSlot::DemagRobinBoundaryEnergy, -1.0e3, 2.0e3);
    const double expected_residual =
        (residual_trial.terms_j[static_cast<size_t>(GpuFinalScalarSlot::DriveEnergy)] -
         residual_base.terms_j[static_cast<size_t>(GpuFinalScalarSlot::DriveEnergy)]) +
        (residual_trial.terms_j[static_cast<size_t>(GpuFinalScalarSlot::CubicAnisotropyEnergy)] -
         residual_base.terms_j[static_cast<size_t>(GpuFinalScalarSlot::CubicAnisotropyEnergy)]) +
        (residual_trial.terms_j[static_cast<size_t>(GpuFinalScalarSlot::MagnetoelasticEnergy)] -
         residual_base.terms_j[static_cast<size_t>(GpuFinalScalarSlot::MagnetoelasticEnergy)]);
    const double expected_operand_scale =
        std::abs(residual_base.terms_j[static_cast<size_t>(GpuFinalScalarSlot::DriveEnergy)]) +
        std::abs(residual_trial.terms_j[static_cast<size_t>(GpuFinalScalarSlot::DriveEnergy)]) +
        std::abs(residual_base.terms_j[static_cast<size_t>(GpuFinalScalarSlot::CubicAnisotropyEnergy)]) +
        std::abs(residual_trial.terms_j[static_cast<size_t>(GpuFinalScalarSlot::CubicAnisotropyEnergy)]) +
        std::abs(residual_base.terms_j[static_cast<size_t>(GpuFinalScalarSlot::MagnetoelasticEnergy)]) +
        std::abs(residual_trial.terms_j[static_cast<size_t>(GpuFinalScalarSlot::MagnetoelasticEnergy)]);
    check(
        fullmag::fem::gpu_compose_term_complete_energy_difference(
            residual_ctx,
            residual_base,
            residual_trial,
            0.0,
            0.0,
            96u,
            difference,
            endpoint_residual_delta,
            endpoint_residual_operand_absolute_sum,
            error) &&
            endpoint_residual_delta == expected_residual &&
            endpoint_residual_operand_absolute_sum == expected_operand_scale &&
            difference.delta_joules == expected_residual,
        "GPU residual composition must include drive, cubic, and magnetoelastic endpoint operands exactly once while excluding Robin diagnostics");
}

void gpu_endpoint_residual_ambiguity_has_no_false_demag_refinement()
{
    fullmag::fem::Context ctx;
    ctx.demag.enabled = true;
    fullmag::fem::GpuDirectArmijoResult result{};
    result.decision =
        fullmag::fem::relaxation::ArmijoDifferenceDecision::Refine;
    result.endpoint_residual_operand_absolute_sum_j = 1.0e-17;
    fullmag::fem::FemGpuComponentField field{};
    std::string error;
    check(
        fullmag::fem::gpu_direct_armijo_refine(
            ctx,
            nullptr,
            0,
            0,
            field,
            field,
            field,
            0.0,
            result,
            error) &&
            !result.refinement_attempted &&
            !result.refinement_accepted &&
            result.refinement_rhs_evaluations == 0u,
        "endpoint-residual ambiguity without a qualified residual refinement must fail closed without relabelling demag refinement");
}

void gpu_demag_refinement_requires_demag_owned_ambiguity()
{
    fullmag::fem::Context ctx;
    ctx.demag.enabled = true;
    constexpr double armijo_rhs_j = -5.0e-35;
    fullmag::fem::GpuDirectArmijoResult result{};
    result.decision =
        fullmag::fem::relaxation::ArmijoDifferenceDecision::Refine;
    result.difference = {-6.0e-35, 1.0, 4.0e-35};
    result.demag_roundoff_bound_j = 3.0e-35;
    check(
        fullmag::fem::gpu_direct_armijo_demag_refinement_eligible(
            ctx, result, armijo_rhs_j),
        "demag refinement must remain eligible when removing the demag-owned bound resolves aggregate Armijo ambiguity");

    result.demag_roundoff_bound_j = 1.0e-35;
    check(
        !fullmag::fem::gpu_direct_armijo_demag_refinement_eligible(
            ctx, result, armijo_rhs_j),
        "demag refinement must be ineligible when exchange/local uncertainty remains ambiguous without the demag-owned bound");

    fullmag::fem::FemGpuComponentField field{};
    std::string error;
    check(
        fullmag::fem::gpu_direct_armijo_refine(
            ctx,
            nullptr,
            0,
            0,
            field,
            field,
            field,
            armijo_rhs_j,
            result,
            error) &&
            !result.refinement_attempted &&
            result.refinement_rhs_evaluations == 0u,
        "non-demag-owned Armijo ambiguity must fail closed without a demag solve");

    result.difference = {-3.0e-35, 1.0, 4.0e-35};
    result.demag_roundoff_bound_j = 3.0e-35;
    check(
        !fullmag::fem::gpu_direct_armijo_demag_refinement_eligible(
            ctx, result, armijo_rhs_j),
        "demag refinement must be ineligible when removing the demag-owned bound already resolves Armijo to Reject");
    check(
        fullmag::fem::gpu_direct_armijo_refine(
            ctx,
            nullptr,
            0,
            0,
            field,
            field,
            field,
            armijo_rhs_j,
            result,
            error) &&
            !result.refinement_attempted &&
            result.refinement_rhs_evaluations == 0u,
        "a non-demag Reject decision must fail closed without a demag solve");
}

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

void cuda_direct_local_absolute_scale_survives_owner_cancellation()
{
    const std::vector<double> zero = {0.0};
    const std::vector<double> one = {1.0};
    const std::vector<double> minus_one = {-1.0};
    double *d_zero = copy_to_device(zero);
    double *d_one = copy_to_device(one);
    double *d_minus_one = copy_to_device(minus_one);
    uint8_t *d_mask = copy_to_device(std::vector<uint8_t>{1u});
    double *d_delta = copy_to_device(zero);
    double *d_absolute = copy_to_device(zero);
    double *d_demag_delta = copy_to_device(zero);
    double *d_demag_absolute = copy_to_device(zero);

    fullmag::fem::fullmag_cuda_relax_direct_energy_difference_blocks(
        d_zero, d_zero, d_zero,
        d_one, d_one, d_zero,
        d_one, d_minus_one, d_zero,
        d_one, d_minus_one, d_zero,
        d_one, d_minus_one, d_zero,
        d_one, d_zero, d_zero,
        d_one, d_zero, d_zero,
        d_one, d_mask,
        true, true, true,
        1.0, -1.0, false, false,
        d_delta, d_absolute, d_demag_delta, d_demag_absolute, 1, nullptr);
    check_cuda(cudaGetLastError(), "CUDA direct local cancellation launch");
    check_cuda(cudaDeviceSynchronize(), "CUDA direct local cancellation synchronize");

    const double delta = copy_scalar_from_device(d_delta);
    const double absolute = copy_scalar_from_device(d_absolute);
    const double demag_delta = copy_scalar_from_device(d_demag_delta);
    const double demag_absolute = copy_scalar_from_device(d_demag_absolute);
    const double tolerance =
        64.0 * std::numeric_limits<double>::epsilon();
    check(
        std::abs(delta) <= tolerance &&
            std::abs(
                absolute - (2.0 + 4.0 * fullmag::fem::kMu0)) <=
                tolerance &&
            std::abs(demag_delta) <= tolerance &&
            std::abs(
                demag_absolute - 2.0 * fullmag::fem::kMu0) <=
                tolerance,
        "within-owner demag components, Zeeman components, and Ku/Ku2 increments must cancel nominally while retaining every scalar subterm magnitude");

    check_cuda(cudaMemset(d_delta, 0, sizeof(double)), "clear disabled-demag delta");
    check_cuda(
        cudaMemset(d_absolute, 0, sizeof(double)),
        "clear disabled-demag absolute scale");
    check_cuda(
        cudaMemset(d_demag_delta, 0, sizeof(double)),
        "clear disabled-demag owned delta");
    check_cuda(
        cudaMemset(d_demag_absolute, 0, sizeof(double)),
        "clear disabled-demag owned absolute scale");
    fullmag::fem::fullmag_cuda_relax_direct_energy_difference_blocks(
        d_zero, d_zero, d_zero,
        d_one, d_one, d_zero,
        d_one, d_minus_one, d_zero,
        d_one, d_minus_one, d_zero,
        d_one, d_minus_one, d_zero,
        d_one, d_zero, d_zero,
        d_one, d_zero, d_zero,
        d_one, d_mask,
        false, false, false,
        1.0, -1.0, false, false,
        d_delta, d_absolute, d_demag_delta, d_demag_absolute, 1, nullptr);
    check_cuda(cudaGetLastError(), "CUDA disabled-demag direct local launch");
    check_cuda(
        cudaDeviceSynchronize(),
        "CUDA disabled-demag direct local synchronize");
    check(
        copy_scalar_from_device(d_delta) == 0.0 &&
            copy_scalar_from_device(d_absolute) == 0.0 &&
            copy_scalar_from_device(d_demag_delta) == 0.0 &&
            copy_scalar_from_device(d_demag_absolute) == 0.0,
        "disabled demag with nonzero endpoint fields must contribute zero signed and absolute energy increments");

    cudaFree(d_zero);
    cudaFree(d_one);
    cudaFree(d_minus_one);
    cudaFree(d_mask);
    cudaFree(d_delta);
    cudaFree(d_absolute);
    cudaFree(d_demag_delta);
    cudaFree(d_demag_absolute);
}

void cuda_exchange_absolute_scale_survives_component_cancellation()
{
    uint32_t *d_rows = copy_to_device(std::vector<uint32_t>{0u, 1u});
    uint32_t *d_cols = copy_to_device(std::vector<uint32_t>{0u});
    double *d_values = copy_to_device(std::vector<double>{1.0});
    double *d_zero = copy_to_device(std::vector<double>{0.0});
    double *d_one = copy_to_device(std::vector<double>{1.0});
    double *d_delta = copy_to_device(std::vector<double>{0.0});
    double *d_absolute = copy_to_device(std::vector<double>{0.0});

    fullmag::fem::fullmag_cuda_legacy_sparse_exchange_difference_blocks(
        d_rows,
        d_cols,
        d_values,
        d_zero, d_one, d_zero,
        d_one, d_zero, d_zero,
        d_delta,
        d_absolute,
        1,
        nullptr);
    check_cuda(cudaGetLastError(), "CUDA exchange cancellation launch");
    check_cuda(cudaDeviceSynchronize(), "CUDA exchange cancellation synchronize");
    check(
        copy_scalar_from_device(d_delta) == 0.0 &&
            copy_scalar_from_device(d_absolute) == 2.0,
        "opposite x/y exchange increments must cancel nominally while retaining both component magnitudes");

    cudaFree(d_rows);
    cudaFree(d_cols);
    cudaFree(d_values);
    cudaFree(d_zero);
    cudaFree(d_one);
    cudaFree(d_delta);
    cudaFree(d_absolute);
}

void cuda_dmi_absolute_scale_survives_polarized_subterm_cancellation()
{
    double *d_nodes = copy_to_device(std::vector<double>{
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    });
    uint32_t *d_elements =
        copy_to_device(std::vector<uint32_t>{0u, 1u, 2u, 3u});
    uint8_t *d_mask = copy_to_device(std::vector<uint8_t>{1u});
    double *d_zero = copy_to_device(std::vector<double>(4u, 0.0));
    double *d_delta = copy_to_device(std::vector<double>{0.0});
    double *d_absolute = copy_to_device(std::vector<double>{0.0});
    const double tolerance = 64.0 * std::numeric_limits<double>::epsilon();

    const auto run_fixture = [&] (
        const std::vector<double> &m0x,
        const std::vector<double> &m0y,
        const std::vector<double> &m0z,
        const std::vector<double> &m1x,
        const std::vector<double> &m1y,
        const std::vector<double> &m1z,
        bool bulk_mode,
        const char *label) {
        double *d_m0x = copy_to_device(m0x);
        double *d_m0y = copy_to_device(m0y);
        double *d_m0z = copy_to_device(m0z);
        double *d_m1x = copy_to_device(m1x);
        double *d_m1y = copy_to_device(m1y);
        double *d_m1z = copy_to_device(m1z);
        check_cuda(cudaMemset(d_delta, 0, sizeof(double)), "clear CUDA DMI delta");
        check_cuda(
            cudaMemset(d_absolute, 0, sizeof(double)),
            "clear CUDA DMI absolute scale");
        fullmag::fem::fullmag_cuda_dmi_energy_difference(
            d_nodes,
            d_elements,
            d_mask,
            d_m0x, d_m0y, d_m0z,
            d_m1x, d_m1y, d_m1z,
            d_zero,
            d_delta,
            d_absolute,
            1.0,
            0.0, 0.0, 1.0,
            false,
            bulk_mode,
            1,
            nullptr);
        check_cuda(cudaGetLastError(), "CUDA DMI cancellation launch");
        check_cuda(cudaDeviceSynchronize(), "CUDA DMI cancellation synchronize");
        check(
            std::abs(copy_scalar_from_device(d_delta)) <= tolerance &&
                std::abs(copy_scalar_from_device(d_absolute) - 1.0 / 6.0) <=
                    tolerance,
            label);
        cudaFree(d_m0x);
        cudaFree(d_m0y);
        cudaFree(d_m0z);
        cudaFree(d_m1x);
        cudaFree(d_m1y);
        cudaFree(d_m1z);
    };

    run_fixture(
        {0.625, 0.125, 0.625, 0.625},
        {0.0, 0.0, 0.0, 0.0},
        {0.625, 0.125, 0.625, 0.625},
        {0.375, 0.875, 0.375, 0.375},
        {0.0, 0.0, 0.0, 0.0},
        {0.375, 0.875, 0.375, 0.375},
        false,
        "interfacial DMI polarized subterms must cancel nominally while retaining the 1/6 absolute oracle");
    run_fixture(
        {0.5, 0.5, 0.5, 0.5},
        {0.5, 0.5, 0.5, 0.5},
        {0.25, -0.25, -0.25, 0.25},
        {0.5, 0.5, 0.5, 0.5},
        {0.5, 0.5, 0.5, 0.5},
        {-0.25, 0.25, 0.25, -0.25},
        true,
        "bulk DMI polarized subterms must cancel nominally while retaining the 1/6 absolute oracle");

    cudaFree(d_nodes);
    cudaFree(d_elements);
    cudaFree(d_mask);
    cudaFree(d_zero);
    cudaFree(d_delta);
    cudaFree(d_absolute);
}

void cuda_pgbb_current_metrics_finite_flags_cover_all_packed_inputs()
{
    double *d_energy_terms = copy_to_device(
        std::vector<double>{1.0e-20, -2.0e-20, 3.0e-20});
    double *d_gradient_norm_sq = copy_to_device(std::vector<double>{4.0});
    double *d_projected_gradient_norm_sq =
        copy_to_device(std::vector<double>{5.0});
    double *d_finite_flags =
        copy_to_device(std::vector<double>{0.0, 0.0, 0.0});

    fullmag::fem::fullmag_cuda_relax_pgbb_current_metrics_finite_flags(
        d_energy_terms,
        3,
        d_gradient_norm_sq,
        d_projected_gradient_norm_sq,
        d_finite_flags);
    check_cuda(cudaGetLastError(), "CUDA PG-BB current metrics flags launch");
    check_cuda(cudaDeviceSynchronize(), "CUDA PG-BB current metrics flags synchronize");
    check(
        copy_vector_from_device(d_finite_flags, 3) ==
            std::vector<double>({1.0, 1.0, 1.0}),
        "packed PG-BB current metrics must mark finite energy terms and nonnegative norms valid");

    const std::vector<double> invalid_energy_terms = {
        1.0, std::numeric_limits<double>::quiet_NaN(), 3.0};
    const double invalid_gradient_norm_sq = -1.0;
    const double invalid_projected_gradient_norm_sq =
        std::numeric_limits<double>::infinity();
    check_cuda(
        cudaMemcpy(
            d_energy_terms,
            invalid_energy_terms.data(),
            invalid_energy_terms.size() * sizeof(double),
            cudaMemcpyHostToDevice),
        "cudaMemcpy invalid PG-BB energy terms host-to-device");
    check_cuda(
        cudaMemcpy(
            d_gradient_norm_sq,
            &invalid_gradient_norm_sq,
            sizeof(double),
            cudaMemcpyHostToDevice),
        "cudaMemcpy invalid PG-BB gradient norm host-to-device");
    check_cuda(
        cudaMemcpy(
            d_projected_gradient_norm_sq,
            &invalid_projected_gradient_norm_sq,
            sizeof(double),
            cudaMemcpyHostToDevice),
        "cudaMemcpy invalid PG-BB projected-gradient norm host-to-device");
    fullmag::fem::fullmag_cuda_relax_pgbb_current_metrics_finite_flags(
        d_energy_terms,
        3,
        d_gradient_norm_sq,
        d_projected_gradient_norm_sq,
        d_finite_flags);
    check_cuda(cudaGetLastError(), "CUDA PG-BB invalid current metrics flags launch");
    check_cuda(cudaDeviceSynchronize(), "CUDA PG-BB invalid current metrics flags synchronize");
    check(
        copy_vector_from_device(d_finite_flags, 3) ==
            std::vector<double>({0.0, 0.0, 0.0}),
        "packed PG-BB current metrics must independently reject non-finite energy terms, negative norms, and non-finite projected-gradient norms");

    cudaFree(d_energy_terms);
    cudaFree(d_gradient_norm_sq);
    cudaFree(d_projected_gradient_norm_sq);
    cudaFree(d_finite_flags);
}

void cuda_heterogeneous_nodal_ms_pgbb_ncg_calibration()
{
    constexpr int calibration_node_count = 3;
    const std::vector<double> previous_x = {1.0, 0.0, 0.0};
    const std::vector<double> previous_y = {0.0, 1.0, 0.0};
    const std::vector<double> previous_z = {0.0, 0.0, 1.0};
    const double inv_sqrt_two = 1.0 / std::sqrt(2.0);
    const std::vector<double> trial_x = {inv_sqrt_two, 0.0, 1.0e6};
    const std::vector<double> trial_y = {inv_sqrt_two, inv_sqrt_two, -1.0e6};
    const std::vector<double> trial_z = {0.0, inv_sqrt_two, 5.0e5};
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
        const std::array<double, 3> accepted_m = {
            trial_x[node], trial_y[node], trial_z[node]};
        const std::array<double, 3> raw_s = {
            accepted_m[0] - previous_x[node],
            accepted_m[1] - previous_y[node],
            accepted_m[2] - previous_z[node],
        };
        const double m_dot_raw_s =
            accepted_m[0] * raw_s[0] +
            accepted_m[1] * raw_s[1] +
            accepted_m[2] * raw_s[2];
        const std::array<double, 3> s = {
            raw_s[0] - m_dot_raw_s * accepted_m[0],
            raw_s[1] - m_dot_raw_s * accepted_m[1],
            raw_s[2] - m_dot_raw_s * accepted_m[2],
        };
        const double m_dot_previous_g =
            accepted_m[0] * previous_gx[node] +
            accepted_m[1] * previous_gy[node] +
            accepted_m[2] * previous_gz[node];
        const std::array<double, 3> y = {
            trial_gx[node] -
                (previous_gx[node] - m_dot_previous_g * accepted_m[0]),
            trial_gy[node] -
                (previous_gy[node] - m_dot_previous_g * accepted_m[1]),
            trial_gz[node] -
                (previous_gz[node] - m_dot_previous_g * accepted_m[2]),
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
    term_complete_composition_preserves_endpoint_operand_uncertainty();
    adverse_drive_endpoint_delta_controls_strict_armijo();
    polarized_exchange_difference_matches_long_double_and_endpoint_oracles();
#if FULLMAG_HAS_MFEM_STACK
    production_exchange_energy_difference_uses_assembled_mfem_form();
#endif
    analytic_absolute_term_sum_resolves_component_cancellation();
    cpu_energy_weight_uses_nodal_ms_and_uniform_fallback();
    dimension_aware_reduction_guards_are_scale_relative();
    strict_monotone_energy_scale_sweep();
    direct_armijo_difference_resolves_sub_ulp_total_energy_decrement();
    polarized_demag_energy_difference_uses_endpoint_fields();
    polarized_robin_boundary_energy_difference_uses_endpoint_potentials();
    direct_zeeman_energy_difference_avoids_endpoint_total_subtraction();
    direct_uniaxial_energy_difference_uses_local_density_difference();
    transported_bb_secant_lives_in_the_accepted_tangent_space();
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
    gpu_energy_increment_ownership_is_context_derived_and_exhaustive();
    gpu_term_complete_composition_retains_direct_zeeman_failure_scale();
    gpu_endpoint_residual_ambiguity_has_no_false_demag_refinement();
    gpu_demag_refinement_requires_demag_owned_ambiguity();
    cuda_direct_local_absolute_scale_survives_owner_cancellation();
    cuda_exchange_absolute_scale_survives_component_cancellation();
    cuda_dmi_absolute_scale_survives_polarized_subterm_cancellation();
    cuda_pgbb_current_metrics_finite_flags_cover_all_packed_inputs();
    cuda_heterogeneous_nodal_ms_pgbb_ncg_calibration();
#endif
    check(
        failed_interactions.empty(),
        "native field-energy directional derivative failures: " +
            (failed_interactions.empty() ? std::string("none") : failed_interactions.front()));
    std::puts("PASS: FEM relaxation energy derivative matrix");
    return 0;
}

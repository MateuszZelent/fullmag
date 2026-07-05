/*
 * operator_contract_test.cpp - native FEM tangent/operator contract tests.
 */

#include "cpu/frequency_domain/mfem_operator_context.hpp"
#include "frequency_domain/anisotropy_operator.hpp"
#include "frequency_domain/equilibrium_state.hpp"
#include "frequency_domain/modal_eigen_solver.hpp"
#include "frequency_domain/operator_contract.hpp"
#include "frequency_domain/operator_terms.hpp"
#include "frequency_domain/tangent_frame.hpp"
#include "frequency_domain/zeeman_operator.hpp"

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <limits>
#include <string>

namespace fd = fullmag::fem::frequency_domain;

namespace {

[[noreturn]] void fail(const char *message)
{
    std::cerr << "operator_contract_test failure: " << message << std::endl;
    std::exit(1);
}

void check(bool condition, const char *message)
{
    if (!condition) {
        fail(message);
    }
}

bool contains(const std::string &haystack, const char *needle)
{
    return haystack.find(needle) != std::string::npos;
}

double exchange_energy(
    const fd::TangentOperatorEdgeBlock &edge,
    const double tangent[4]) noexcept
{
    const double d0 = tangent[0] - tangent[2];
    const double d1 = tangent[1] - tangent[3];
    return 0.5 * edge.stiffness * (d0 * d0 + d1 * d1);
}

double uniaxial_quadratic_energy(
    const fd::TangentFrameNode &node,
    const double axis[3],
    double anisotropy_field_a_per_m,
    const double tangent[2]) noexcept
{
    double unit_axis[3] = {axis[0], axis[1], axis[2]};
    const double axis_norm =
        std::sqrt(fd::dot3(unit_axis, unit_axis));
    check(axis_norm > 0.0, "anisotropy axis must be non-zero in test");
    unit_axis[0] /= axis_norm;
    unit_axis[1] /= axis_norm;
    unit_axis[2] /= axis_norm;
    const double u1 = fd::dot3(unit_axis, node.e1);
    const double u2 = fd::dot3(unit_axis, node.e2);
    const double projection = u1 * tangent[0] + u2 * tangent[1];
    return 0.5 * anisotropy_field_a_per_m * projection * projection;
}

void check_relative_close(double actual, double expected, double tolerance, const char *message)
{
    const double denom =
        std::fmax(std::fmax(std::abs(actual), std::abs(expected)), 1.0e-30);
    if (std::abs(actual - expected) / denom > tolerance) {
        fail(message);
    }
}

void tangent_frame_is_orthonormal()
{
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    fd::TangentFrameNode nodes[3]{};
    fd::TangentFrameDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status =
        fd::build_tangent_frame(equilibrium, 3, nodes, &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "tangent frame build should succeed");
    check(diagnostics.max_norm_error < 1.0e-12, "tangent frame norm diagnostics should be tiny");
    for (const auto &node : nodes) {
        check_relative_close(fd::dot3(node.e1, node.e1), 1.0, 1.0e-12, "e1 must be unit");
        check_relative_close(fd::dot3(node.e2, node.e2), 1.0, 1.0e-12, "e2 must be unit");
        check(std::abs(fd::dot3(node.e1, node.e2)) < 1.0e-12, "e1 and e2 must be orthogonal");
        check(std::abs(fd::dot3(node.e1, node.m)) < 1.0e-12, "e1 must be tangent");
        check(std::abs(fd::dot3(node.e2, node.m)) < 1.0e-12, "e2 must be tangent");
        const double handedness[3] = {
            node.e1[1] * node.e2[2] - node.e1[2] * node.e2[1],
            node.e1[2] * node.e2[0] - node.e1[0] * node.e2[2],
            node.e1[0] * node.e2[1] - node.e1[1] * node.e2[0],
        };
        check(fd::dot3(handedness, node.m) > 0.999999999, "e1 x e2 must align with m0");
    }
}

void mass_apply_preserves_dimension()
{
    const double equilibrium[] = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    };
    fd::TangentFrameNode nodes[2]{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 2, nodes, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "mass test tangent frame must build");

    const double tangent_delta[] = {2.0, -3.0, 4.0, 5.0};
    const double alpha_per_node[] = {0.1, 0.3};
    double mass_tangent[4]{};
    fd::TangentFrequencyMassDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::apply_tangent_frequency_mass_operator(
        nodes,
        tangent_delta,
        fd::tangent_workspace_shape(2),
        0.0,
        alpha_per_node,
        mass_tangent,
        &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "mass operator should succeed");
    check(diagnostics.node_count == 2, "mass diagnostics must keep node count");
    check(diagnostics.tangent_dof_count == 4, "mass diagnostics must keep tangent DOF count");
    check(std::isfinite(mass_tangent[0]) && std::isfinite(mass_tangent[3]), "mass output must be finite");
}

void operator_request_rejects_tangent_dof_overflow()
{
    fd::FrequencyDomainOperatorRequest request{};
    request.node_count = std::numeric_limits<std::uint64_t>::max() / 2 + 1;
    request.tangent_dof_count = 0;
    request.gamma0 = 1.0;
    request.alpha = 0.0;
    fd::FrequencyDomainOperatorValidationDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status =
        fd::validate_frequency_domain_operator_request(request, &diagnostics);

    check(
        status == fd::FrequencyDomainStatus::validation_error,
        "operator request must reject tangent DOF overflow");
    check(
        contains(diagnostics.error_message, "2 tangent DOFs"),
        "operator request overflow rejection must name tangent DOFs");
}

void zeeman_operator_matches_macrospin_precession()
{
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "macrospin tangent frame must build");

    const double h_ext_a_per_m[] = {0.0, 0.0, 3.0};
    fd::TangentOperatorLocalBlock block{};
    fd::ZeemanTangentOperatorDiagnostics zeeman_diagnostics{};
    check(
        fd::build_zeeman_tangent_blocks(&node, h_ext_a_per_m, 1, &block, &zeeman_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "Zeeman block build must succeed");

    const double tangent_delta[] = {2.0, -1.0};
    double field_tangent[2]{};
    fd::TangentOperatorDiagnostics operator_diagnostics{};
    check(
        fd::apply_tangent_nodewise_operator(
            &block,
            tangent_delta,
            fd::tangent_workspace_shape(1),
            field_tangent,
            &operator_diagnostics) == fd::FrequencyDomainStatus::ok,
        "Zeeman nodewise operator must succeed");

    double rhs_tangent[2]{};
    fd::TangentPrecessionDiagnostics precession_diagnostics{};
    check(
        fd::apply_tangent_precession_operator(
            &node,
            field_tangent,
            fd::tangent_workspace_shape(1),
            10.0,
            rhs_tangent,
            &precession_diagnostics) == fd::FrequencyDomainStatus::ok,
        "precession operator must succeed");

    check_relative_close(rhs_tangent[0], 30.0, 1.0e-12, "macrospin precession e1");
    check_relative_close(rhs_tangent[1], 60.0, 1.0e-12, "macrospin precession e2");
}

void exchange_directional_derivative_matches_finite_difference()
{
    const fd::TangentOperatorEdgeBlock edge{
        fd::FrequencyDomainOperatorTermKind::exchange,
        0,
        1,
        2.0,
    };
    const double tangent_q[] = {1.0, -2.0, 0.5, 3.0};
    const double direction[] = {0.25, -0.5, 0.75, 0.125};
    double gradient[4]{};
    fd::TangentEdgeOperatorDiagnostics diagnostics{};
    check(
        fd::apply_tangent_edge_operator(
            &edge,
            1,
            tangent_q,
            fd::tangent_workspace_shape(2),
            gradient,
            &diagnostics) == fd::FrequencyDomainStatus::ok,
        "exchange operator must succeed");

    const double analytic_directional =
        gradient[0] * direction[0] + gradient[1] * direction[1] +
        gradient[2] * direction[2] + gradient[3] * direction[3];
    constexpr double eps = 1.0e-6;
    double q_plus[4]{};
    double q_minus[4]{};
    for (int i = 0; i < 4; ++i) {
        q_plus[i] = tangent_q[i] + eps * direction[i];
        q_minus[i] = tangent_q[i] - eps * direction[i];
    }
    const double finite_difference =
        (exchange_energy(edge, q_plus) - exchange_energy(edge, q_minus)) / (2.0 * eps);
    check_relative_close(
        analytic_directional,
        finite_difference,
        1.0e-6,
        "exchange directional derivative must match finite difference");
}

void anisotropy_directional_derivative_matches_finite_difference()
{
    const double equilibrium[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::TangentFrameDiagnostics frame_diagnostics{};
    check(
        fd::build_tangent_frame(equilibrium, 1, &node, &frame_diagnostics) ==
            fd::FrequencyDomainStatus::ok,
        "anisotropy tangent frame must build");

    const double axis[] = {1.0, 1.0, 0.0};
    constexpr double anisotropy_field_a_per_m = 4.0;
    fd::TangentOperatorLocalBlock block{};
    fd::UniaxialAnisotropyTangentOperatorDiagnostics diagnostics{};
    check(
        fd::build_uniaxial_anisotropy_tangent_blocks(
            &node,
            axis,
            anisotropy_field_a_per_m,
            1,
            &block,
            &diagnostics) == fd::FrequencyDomainStatus::ok,
        "anisotropy block build must succeed");

    const double tangent_q[] = {0.3, -0.2};
    const double direction[] = {0.15, 0.4};
    double gradient[2]{};
    fd::TangentOperatorDiagnostics operator_diagnostics{};
    check(
        fd::apply_tangent_nodewise_operator(
            &block,
            tangent_q,
            fd::tangent_workspace_shape(1),
            gradient,
            &operator_diagnostics) == fd::FrequencyDomainStatus::ok,
        "anisotropy nodewise operator must succeed");

    const double analytic_directional =
        gradient[0] * direction[0] + gradient[1] * direction[1];
    constexpr double eps = 1.0e-6;
    const double q_plus[] = {
        tangent_q[0] + eps * direction[0],
        tangent_q[1] + eps * direction[1],
    };
    const double q_minus[] = {
        tangent_q[0] - eps * direction[0],
        tangent_q[1] - eps * direction[1],
    };
    const double finite_difference =
        (uniaxial_quadratic_energy(node, axis, anisotropy_field_a_per_m, q_plus) -
            uniaxial_quadratic_energy(node, axis, anisotropy_field_a_per_m, q_minus)) /
        (2.0 * eps);
    check_relative_close(
        analytic_directional,
        finite_difference,
        1.0e-6,
        "anisotropy directional derivative must match finite difference");
}

void operator_rejects_non_unit_equilibrium_above_tolerance()
{
    const double equilibrium[] = {0.0, 0.0, 0.8};
    const double static_field[] = {0.0, 0.0, 1.0};
    fd::TangentFrameNode node{};
    fd::EquilibriumStateDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::build_equilibrium_state(
        equilibrium,
        static_field,
        1,
        1.0e-9,
        &node,
        &diagnostics);

    check(
        status == fd::FrequencyDomainStatus::validation_error,
        "equilibrium state must reject non-unit equilibrium");
    check(contains(diagnostics.error_message, "unit"), "equilibrium rejection must mention unit vectors");
}

void operator_diagnostics_report_required_fields()
{
    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 4;
    descriptor.full_dof_count = 12;
    descriptor.tangent_dof_count = 8;
    descriptor.exchange_enabled = true;
    descriptor.zeeman_enabled = true;
    descriptor.uniaxial_anisotropy_enabled = true;
    descriptor.dmi_enabled = true;
    descriptor.demag_enabled = true;
    descriptor.demag_kind = fd::FrequencyDomainDemagKind::static_k0;
    descriptor.mfem_mesh_available = true;

    fd::EquilibriumStateDiagnostics equilibrium{};
    equilibrium.node_count = 4;
    equilibrium.max_norm_error = 1.0e-12;
    equilibrium.max_m_cross_h_abs = 2.5e-4;
    equilibrium.rms_m_cross_h_abs = 1.25e-4;

    fd::LinearizedLlgOperatorDiagnostics diagnostics{};
    const fd::FrequencyDomainStatus status =
        fd::build_linearized_llg_operator_diagnostics(
            descriptor,
            equilibrium,
            "poisson_robin",
            &diagnostics);

    check(status == fd::FrequencyDomainStatus::ok, "operator diagnostics build should succeed");
    check(diagnostics.active_node_count == 4, "operator diagnostics active nodes");
    check(diagnostics.tangent_dof_count == 8, "operator diagnostics tangent DOFs");
    check(diagnostics.exchange_enabled, "operator diagnostics exchange flag");
    check(diagnostics.zeeman_enabled, "operator diagnostics zeeman flag");
    check(diagnostics.uniaxial_anisotropy_enabled, "operator diagnostics anisotropy flag");
    check(diagnostics.dmi_enabled, "operator diagnostics dmi flag");
    check(diagnostics.demag_enabled, "operator diagnostics demag flag");
    check(std::strcmp(diagnostics.frequency_units, "Hz") == 0, "operator diagnostics frequency units");
    check(std::strcmp(diagnostics.angular_frequency_units, "rad/s") == 0, "operator diagnostics angular frequency units");
    check(std::strcmp(diagnostics.field_units, "A_per_m") == 0, "operator diagnostics field units");
    check_relative_close(
        diagnostics.equilibrium_norm_error_max_abs,
        1.0e-12,
        1.0e-12,
        "operator diagnostics equilibrium norm error");
    check_relative_close(
        diagnostics.equilibrium_residual_max_abs,
        2.5e-4,
        1.0e-12,
        "operator diagnostics equilibrium residual");
    check_relative_close(
        diagnostics.equilibrium_residual_rms,
        1.25e-4,
        1.0e-12,
        "operator diagnostics equilibrium rms residual");
    check(
        std::strcmp(diagnostics.demag_realization, "poisson_robin") == 0,
        "operator diagnostics demag realization");
}

void operator_diagnostics_reject_mismatched_equilibrium()
{
    fd::MfemOperatorContextDescriptor descriptor{};
    descriptor.node_count = 4;
    descriptor.full_dof_count = 12;
    descriptor.tangent_dof_count = 8;

    fd::EquilibriumStateDiagnostics equilibrium{};
    equilibrium.node_count = 3;
    equilibrium.max_norm_error = 0.0;
    equilibrium.max_m_cross_h_abs = 0.0;
    equilibrium.rms_m_cross_h_abs = 0.0;

    fd::LinearizedLlgOperatorDiagnostics diagnostics{};
    const fd::FrequencyDomainStatus status =
        fd::build_linearized_llg_operator_diagnostics(
            descriptor,
            equilibrium,
            "none",
            &diagnostics);

    check(
        status == fd::FrequencyDomainStatus::validation_error,
        "operator diagnostics must reject equilibrium/node-count mismatch");
    check(
        contains(diagnostics.error_message, "node count"),
        "operator diagnostics mismatch error names node count");
}

void equilibrium_state_rejects_nonfinite_static_field()
{
    const double equilibrium[] = {0.0, 0.0, 1.0};
    const double static_field[] = {0.0, std::nan(""), 1.0};
    fd::TangentFrameNode node{};
    fd::EquilibriumStateDiagnostics diagnostics{};

    const fd::FrequencyDomainStatus status = fd::build_equilibrium_state(
        equilibrium,
        static_field,
        1,
        1.0e-9,
        &node,
        &diagnostics);

    check(
        status == fd::FrequencyDomainStatus::validation_error,
        "equilibrium state must reject non-finite static field");
    check(
        contains(diagnostics.error_message, "finite"),
        "equilibrium static-field rejection must mention finite values");
}

void modal_contract_preserves_operator_diagnostics_json()
{
    fd::ModalEigenRequest request{};
    request.abi_version = fd::kFrequencyDomainAbiVersion;
    request.operator_request.abi_version = fd::kFrequencyDomainAbiVersion;
    request.operator_request.mesh_asset_id = "mesh";
    request.operator_request.equilibrium_source_kind = "relax";
    request.operator_request.gamma_rad_s_T = 1.760859e11;
    request.operator_request.mu0_T_m_A = 1.25663706212e-6;
    request.operator_request.alpha = 0.01;
    request.operator_request.include_exchange = 1;
    request.operator_request.damping_policy = "include";
    request.operator_request.spin_wave_bc_kind = "free";
    request.operator_request.operator_diagnostics_json =
        "{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\","
        "\"active_node_count\":4,"
        "\"tangent_dof_count\":8}";
    request.requested_mode_count = 4;
    request.target_kind = "frequency_window";
    request.frequency_min_hz = 1.0e8;
    request.frequency_max_hz = 5.0e9;
    request.residual_tolerance = 1.0e-8;
    request.max_outer_iterations = 16;
    request.max_linear_iterations = 64;

    const fd::FrequencyDomainContractResult result =
        fd::solve_modal_eigen_contract(request);

    check(result.status == fd::FrequencyDomainStatus::unavailable, "modal contract should stay unavailable");
    check(
        contains(result.diagnostics_json, "\"operator_diagnostics\":{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\""),
        "modal diagnostics must embed operator diagnostics");
    check(
        contains(result.diagnostics_json, "\"active_node_count\":4"),
        "modal diagnostics must preserve active node count");
}

void driven_response_contract_preserves_operator_diagnostics_json()
{
    const double frequencies_hz[] = {1.0e9};
    const double excitation[] = {0.0, 0.0, 1.0};
    fd::DrivenResponseContractRequest request{};
    request.abi_version = fd::kFrequencyDomainAbiVersion;
    request.operator_request.abi_version = fd::kFrequencyDomainAbiVersion;
    request.operator_request.mesh_asset_id = "mesh";
    request.operator_request.equilibrium_source_kind = "relax";
    request.operator_request.gamma_rad_s_T = 1.760859e11;
    request.operator_request.mu0_T_m_A = 1.25663706212e-6;
    request.operator_request.alpha = 0.01;
    request.operator_request.include_exchange = 1;
    request.operator_request.damping_policy = "include";
    request.operator_request.spin_wave_bc_kind = "free";
    request.operator_request.operator_diagnostics_json =
        "{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\","
        "\"active_node_count\":6,"
        "\"tangent_dof_count\":12}";
    request.frequencies_hz = frequencies_hz;
    request.frequency_count = 1;
    request.excitation_field_A_m = excitation;
    request.excitation_field_len = 3;
    request.residual_tolerance = 1.0e-8;
    request.max_linear_iterations = 64;

    const fd::FrequencyDomainContractResult result =
        fd::solve_driven_response_contract(request);

    check(result.status == fd::FrequencyDomainStatus::validation_error, "legacy driven contract should reject missing operator payload");
    check(
        contains(result.diagnostics_json, "\"operator_diagnostics\":{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\""),
        "driven diagnostics must embed operator diagnostics");
    check(
        contains(result.diagnostics_json, "\"active_node_count\":6"),
        "driven diagnostics must preserve active node count");
}

} // namespace

int main()
{
    tangent_frame_is_orthonormal();
    mass_apply_preserves_dimension();
    operator_request_rejects_tangent_dof_overflow();
    zeeman_operator_matches_macrospin_precession();
    exchange_directional_derivative_matches_finite_difference();
    anisotropy_directional_derivative_matches_finite_difference();
    operator_rejects_non_unit_equilibrium_above_tolerance();
    operator_diagnostics_report_required_fields();
    operator_diagnostics_reject_mismatched_equilibrium();
    equilibrium_state_rejects_nonfinite_static_field();
    modal_contract_preserves_operator_diagnostics_json();
    driven_response_contract_preserves_operator_diagnostics_json();
    return 0;
}

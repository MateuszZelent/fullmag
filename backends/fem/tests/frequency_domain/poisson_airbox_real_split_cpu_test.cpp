#include "cpu/frequency_domain/poisson_airbox_modal_eigen.hpp"
#include "frequency_domain/dense_poisson_airbox_eigen_oracle.hpp"
#include "frequency_domain/modal_eigen_solver.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace fd = fullmag::fem::frequency_domain;

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

struct CsrOwned {
    std::uint64_t rows = 0;
    std::uint64_t columns = 0;
    std::vector<std::uint32_t> row_offsets{};
    std::vector<std::uint32_t> column_indices{};
    std::vector<double> values{};

    fd::CsrMatrixView view() const noexcept
    {
        return fd::CsrMatrixView{
            rows,
            columns,
            row_offsets.data(),
            static_cast<std::uint64_t>(row_offsets.size()),
            column_indices.data(),
            static_cast<std::uint64_t>(column_indices.size()),
            values.data(),
            static_cast<std::uint64_t>(values.size())};
    }
};

CsrOwned dense_to_csr(
    std::uint64_t rows,
    std::uint64_t columns,
    const double *values)
{
    CsrOwned csr{};
    csr.rows = rows;
    csr.columns = columns;
    csr.row_offsets.push_back(0u);
    for (std::uint64_t row = 0; row < rows; ++row) {
        for (std::uint64_t column = 0; column < columns; ++column) {
            const double value = values[row * columns + column];
            if (value != 0.0) {
                csr.column_indices.push_back(static_cast<std::uint32_t>(column));
                csr.values.push_back(value);
            }
        }
        csr.row_offsets.push_back(static_cast<std::uint32_t>(csr.values.size()));
    }
    return csr;
}

fd::PoissonAirboxEigenBlockProblem make_problem(
    const CsrOwned &a_qq,
    const CsrOwned &a_qphi,
    const CsrOwned &a_phiq,
    const CsrOwned &a_phiphi,
    const CsrOwned &b_qq,
    const double *weights,
    double expected_frequency_hz)
{
    fd::PoissonAirboxEigenBlockProblem problem{};
    problem.q_dof_count = 2;
    problem.phi_dof_count = 2;
    problem.A_qq = a_qq.view();
    problem.A_qphi = a_qphi.view();
    problem.A_phiq = a_phiq.view();
    problem.A_phiphi = a_phiphi.view();
    problem.B_qq = b_qq.view();
    problem.phi_mean_weights = weights;
    problem.phi_mean_weights_count = 2;
    problem.outer_boundary_kind = "pure_neumann";
    problem.gauge_policy = "mean_zero_augmented";
    problem.gauge_reason = "pure_neumann_nullspace";
    problem.assembly_kind = "synthetic_algebraic_oracle";
    problem.target_frequency_hz = 2.0e9;
    problem.expected_reference_frequency_hz = expected_frequency_hz;
    problem.periodic_mesh_certificate_schema = "periodic_mesh_certificate.v5";
    problem.magnetic_pair_count = 1;
    problem.airbox_pair_count = 1;
    return problem;
}

} // namespace

int main()
{
    constexpr double two_pi = 6.283185307179586476925286766559;
    const double a_qq[4] = {
        0.0, -two_pi * 2.0e9,
        two_pi * 2.0e9, 0.0};
    const double a_qphi[4] = {-1.5e8, 1.5e8, 0.0, 0.0};
    const double a_phiq[4] = {0.0, -1.0, 0.0, 1.0};
    const double a_phiphi[4] = {1.0, -1.0, -1.0, 1.0};
    const double b_qq[4] = {1.0, 0.0, 0.0, 1.0};
    const double weights[2] = {0.5, 0.5};
    const CsrOwned A_qq = dense_to_csr(2, 2, a_qq);
    const CsrOwned A_qphi = dense_to_csr(2, 2, a_qphi);
    const CsrOwned A_phiq = dense_to_csr(2, 2, a_phiq);
    const CsrOwned A_phiphi = dense_to_csr(2, 2, a_phiphi);
    const CsrOwned B_qq = dense_to_csr(2, 2, b_qq);

    fd::DensePoissonAirboxEigenOracleProblem dense_problem{};
    dense_problem.q_dof_count = 2;
    dense_problem.phi_dof_count = 2;
    dense_problem.A_qq = {a_qq, 2, 2};
    dense_problem.A_qphi = {a_qphi, 2, 2};
    dense_problem.A_phiq = {a_phiq, 2, 2};
    dense_problem.A_phiphi = {a_phiphi, 2, 2};
    dense_problem.B_qq = {b_qq, 2, 2};
    dense_problem.phi_mean_weights = weights;
    dense_problem.phi_mean_weights_count = 2;
    fd::DensePoissonAirboxEigenOracleResult dense_result{};
    check(
        fd::solve_dense_poisson_airbox_eigen_oracle(dense_problem, &dense_result) ==
            fd::FrequencyDomainStatus::ok,
        dense_result.error_message);

    fd::PoissonAirboxEigenBlockProblem problem = make_problem(
        A_qq, A_qphi, A_phiq, A_phiphi, B_qq, weights, dense_result.frequency_hz);
    fd::PoissonAirboxModalEigenResult result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_slepc(problem, &result) ==
            fd::FrequencyDomainStatus::ok,
        result.error_message);
    check(result.positive_frequency_branch_found,
          "real-frequency-rotated CPU solve must select a positive branch");
    check(result.full_residual_certified,
          "real-frequency-rotated CPU solve must certify the reconstructed residual");
    check(std::strstr(result.diagnostics_json,
                      "\"spectral_pencil_kind\":\"real_frequency_rotated\"") != nullptr,
          "CPU diagnostics must identify the real-frequency-rotated pencil");
    check(std::strstr(result.diagnostics_json,
                      "\"target_representation\":\"tau=omega_target\"") != nullptr,
          "CPU diagnostics must identify tau=omega_target");

    fd::PoissonAirboxEigenBlockProblem postsolve_only_reference = problem;
    postsolve_only_reference.expected_reference_frequency_hz = 1.0;
    fd::PoissonAirboxModalEigenResult postsolve_only_result{};
    check(
        fd::solve_poisson_airbox_modal_eigen_cpu_slepc(
            postsolve_only_reference,
            &postsolve_only_result) == fd::FrequencyDomainStatus::ok,
        "analytical reference mismatch must not gate the modal solve");
    check(
        !postsolve_only_result.reference_frequency_certified,
        "analytical reference mismatch must remain visible as postsolve metadata");

    // Exercise the public contract serializer through the native entry point
    // as well: the scalar result is not sufficient for mode artifacts.
    check(result.accepted_mode_count >= 1 && !result.accepted_modes.empty(),
          "CPU solve must retain at least one complete mode vector");
    check(result.accepted_modes.front().full_vector.size() == 5,
          "CPU mode result must retain q, phi, and gauge components");

    fd::ModalEigenRequest native_request{};
    native_request.operator_request.gamma_rad_s_T = 1.76085963023e11;
    native_request.operator_request.mu0_T_m_A = 1.25663706212e-6;
    native_request.requested_mode_count = 1;
    native_request.target_kind = "nearest_frequency";
    native_request.target_frequency_hz = 2.0e9;
    native_request.residual_tolerance = 1.0e-10;
    native_request.max_outer_iterations = 64;
    native_request.max_linear_iterations = 128;
    native_request.poisson_airbox_block_enabled = 1;
    native_request.poisson_airbox_q_dof_count = 2;
    native_request.poisson_airbox_phi_dof_count = 2;
    native_request.poisson_airbox_a_qq_csr = A_qq.view();
    native_request.poisson_airbox_a_qphi_csr = A_qphi.view();
    native_request.poisson_airbox_a_phiq_csr = A_phiq.view();
    native_request.poisson_airbox_a_phiphi_csr = A_phiphi.view();
    native_request.poisson_airbox_b_qq_csr = B_qq.view();
    native_request.poisson_airbox_phi_mean_weights = weights;
    native_request.poisson_airbox_phi_mean_weights_count = 2;
    native_request.poisson_airbox_target_frequency_hz = 2.0e9;
    native_request.poisson_airbox_expected_reference_frequency_hz = dense_result.frequency_hz;
    native_request.poisson_airbox_periodic_mesh_certificate_schema =
        "periodic_mesh_certificate.v5";
    native_request.poisson_airbox_magnetic_pair_count = 1;
    native_request.poisson_airbox_airbox_pair_count = 1;
    native_request.poisson_airbox_outer_boundary_kind = "pure_neumann";
    native_request.poisson_airbox_gauge_policy = "mean_zero_augmented";
    native_request.poisson_airbox_gauge_reason = "pure_neumann_nullspace";
    native_request.poisson_airbox_assembly_kind = "synthetic_algebraic_oracle";
    const fd::FrequencyDomainContractResult native_result =
        fd::solve_modal_eigen_contract(native_request);
    check(native_result.status == fd::FrequencyDomainStatus::ok,
          native_result.error_message.c_str());
    check(std::strstr(native_result.result_json.c_str(), "\"modes\":[") != nullptr,
          "native modal result must expose a multi-mode array");
    check(std::strstr(native_result.result_json.c_str(), "\"mode_phi_real\":[") != nullptr,
          "native modal result must expose reconstructed potential components");
}

#include "cpu/frequency_domain/poisson_airbox_modal_eigen.hpp"
#include "frequency_domain/modal_gpu_krylov.hpp"

#include <slepceps.h>

#include <cmath>
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

CsrOwned dense_to_csr(std::uint64_t rows, std::uint64_t columns, const double *values)
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

} // namespace

int main()
{
    constexpr double two_pi = 6.283185307179586476925286766559;
    // Production weak-form matrices carry SI volume scaling.  A common
    // pencil scale must not change the physical eigenfrequency or prevent
    // the independent full-descriptor residual from being certified.
    constexpr double pencil_scale = 1.0e-18;
    const double a_qq_values[4] = {
        0.0, -pencil_scale * two_pi * 2.0e9,
        pencil_scale * two_pi * 2.0e9, 0.0};
    const double a_qphi_values[4] = {
        -pencil_scale * 1.5e8, pencil_scale * 1.5e8, 0.0, 0.0};
    const double a_phiq_values[4] = {
        0.0, -pencil_scale, 0.0, pencil_scale};
    // A coercive scalar block avoids a gauge nullspace in this runtime-owner
    // contract while retaining non-zero dynamic-demag coupling.
    const double a_phiphi_values[4] = {
        2.0 * pencil_scale, -pencil_scale, -pencil_scale, 2.0 * pencil_scale};
    const double b_qq_values[4] = {pencil_scale, 0.0, 0.0, pencil_scale};
    const CsrOwned a_qq = dense_to_csr(2, 2, a_qq_values);
    const CsrOwned a_qphi = dense_to_csr(2, 2, a_qphi_values);
    const CsrOwned a_phiq = dense_to_csr(2, 2, a_phiq_values);
    const CsrOwned a_phiphi = dense_to_csr(2, 2, a_phiphi_values);
    const CsrOwned b_qq = dense_to_csr(2, 2, b_qq_values);

    fd::PoissonAirboxEigenBlockProblem problem{};
    problem.q_dof_count = 2;
    problem.phi_dof_count = 2;
    problem.A_qq = a_qq.view();
    problem.A_qphi = a_qphi.view();
    problem.A_phiq = a_phiq.view();
    problem.A_phiphi = a_phiphi.view();
    problem.B_qq = b_qq.view();
    problem.outer_boundary_kind = "poisson_robin";
    problem.robin_beta = 1.0;
    problem.gauge_policy = "none";
    problem.gauge_reason = "coercive_outer_boundary";
    // This target exercises the bounded PETSc/CUDA adapter with algebraic
    // matrices.  It must never be reported as production shared-domain FEM.
    problem.assembly_kind = "synthetic_algebraic_oracle";
    problem.production_shared_domain = false;
    problem.validation_only_adapter = true;
    problem.solver_adapter = "k0_poisson_airbox_gpu_petsc_slepc";
    problem.periodic_mesh_certificate_schema = "periodic_mesh_certificate.v6";
    problem.magnetic_pair_count = 1;
    problem.airbox_pair_count = 1;
    problem.target_frequency_hz = 2.0e9;
    problem.requested_mode_count = 1;
    problem.residual_tolerance = 1.0e-8;
    problem.max_outer_iterations = 128;
    problem.max_linear_iterations = 256;

    // Validation must reject an empty mode request before probing CUDA/SLEPc;
    // a caller must never receive a solver-unavailable error for malformed
    // modal intent.
    problem.requested_mode_count = 0;
    fd::PoissonAirboxModalEigenResult invalid_count{};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(problem, &invalid_count) ==
            fd::FrequencyDomainStatus::validation_error,
        "GPU K0 must reject a zero requested mode count before allocation");
    check(
        std::strstr(invalid_count.diagnostics_json, "gpu_k0_requested_mode_count_invalid") !=
            nullptr,
        "GPU K0 zero-count diagnostics must expose the stable validation reason");

    problem.requested_mode_count = 1;
    problem.target_kind = "frequency_window";
    problem.frequency_min_hz = 3.0e9;
    problem.frequency_max_hz = 3.0e9;
    fd::PoissonAirboxModalEigenResult invalid_window{};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(problem, &invalid_window) ==
            fd::FrequencyDomainStatus::validation_error,
        "GPU K0 must reject a degenerate frequency window before allocation");
    check(
        std::strstr(invalid_window.diagnostics_json, "gpu_k0_target_invalid") != nullptr,
        "GPU K0 invalid target diagnostics must expose the stable validation reason");

    problem.target_kind = "unsupported_target";
    problem.frequency_min_hz = 0.0;
    problem.frequency_max_hz = 0.0;
    fd::PoissonAirboxModalEigenResult invalid_target_kind{};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(
            problem, &invalid_target_kind) == fd::FrequencyDomainStatus::validation_error,
        "GPU K0 must reject an unknown target kind before allocation");
    check(
        std::strstr(invalid_target_kind.diagnostics_json, "gpu_k0_target_invalid") != nullptr,
        "GPU K0 unknown-target diagnostics must expose the stable validation reason");

    problem.target_kind = "nearest_frequency";
    problem.phasor_convention = "exp_minus_i_omega_t";
    fd::PoissonAirboxModalEigenResult invalid_phasor_convention{};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(
            problem, &invalid_phasor_convention) ==
            fd::FrequencyDomainStatus::validation_error,
        "GPU K0 must reject a noncanonical phasor convention before allocation");
    check(
        std::strstr(
            invalid_phasor_convention.diagnostics_json,
            "gpu_k0_convention_invalid") != nullptr,
        "GPU K0 phasor-convention diagnostics must expose the stable validation reason");

    problem.phasor_convention = "exp_plus_i_omega_t";
    problem.eigenvalue_convention = "lambda_real_positive_frequency";
    fd::PoissonAirboxModalEigenResult invalid_eigenvalue_convention{};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(
            problem, &invalid_eigenvalue_convention) ==
            fd::FrequencyDomainStatus::validation_error,
        "GPU K0 must reject a noncanonical eigenvalue convention before allocation");
    check(
        std::strstr(
            invalid_eigenvalue_convention.diagnostics_json,
            "gpu_k0_convention_invalid") != nullptr,
        "GPU K0 eigenvalue-convention diagnostics must expose the stable validation reason");

    problem.eigenvalue_convention = "lambda_imag_positive_frequency";

    fd::PoissonAirboxModalEigenResult gpu{};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(problem, &gpu) ==
            fd::FrequencyDomainStatus::ok,
        gpu.error_message);
    check(gpu.accepted_mode_count >= 1, "GPU solve must retain an accepted mode");
    check(gpu.q_dof_count == problem.q_dof_count && gpu.phi_dof_count == problem.phi_dof_count,
          "GPU result must publish the native magnetic and scalar DOF counts");
    check(gpu.augmented_dof_count == problem.q_dof_count + problem.phi_dof_count,
          "GPU result must publish the native augmented DOF count");
    check(gpu.full_residual_certified, "GPU solve must certify the full descriptor residual");
    // The persistent Schur context uploads A_qq, A_qphi, A_phiq, A_phiphi,
    // and the full-residual B_qq block once. The real-split mass is
    // materialized for this solve, so all six setup block transfers are
    // accounted for in the public telemetry.
    check(gpu.setup_h2d_transfer_count == 6,
          "GPU solve must count B_qq and the split mass setup transfers");
    check(
        std::strstr(gpu.diagnostics_json, "\"setup_h2d_transfer_count\":6") != nullptr,
        "GPU diagnostics must publish the B_qq setup transfer");
    check(gpu.final_d2h_transfer_count >= 4,
          "GPU solve must report the four final mode-vector device-to-host transfers");
    check(gpu.hot_loop_allocations == 0,
          "GPU modal action loop must not allocate after persistent setup");
    check(gpu.hot_loop_h2d_bytes == 0 && gpu.hot_loop_d2h_bytes == 0,
          "GPU modal action loop must not transfer vector bytes");
    check(
        std::strstr(gpu.diagnostics_json, "\"hot_loop_allocations\":0") != nullptr,
        "GPU diagnostics must publish zero hot-loop allocations");
    check(
        std::strstr(gpu.diagnostics_json, "\"hot_loop_h2d_bytes\":0") != nullptr &&
            std::strstr(gpu.diagnostics_json, "\"hot_loop_d2h_bytes\":0") != nullptr,
        "GPU diagnostics must publish zero hot-loop transfer bytes");
    check(
        std::strstr(gpu.diagnostics_json, "\"augmented_dof_count\":4") != nullptr,
        "GPU diagnostics must publish the native augmented DOF count");
    check(
        std::abs(gpu.frequency_hz - problem.target_frequency_hz) <=
            0.05 * problem.target_frequency_hz,
        "GPU frequency must remain on the targeted K0 branch");
    check(
        std::strstr(gpu.diagnostics_json, "\"spectral_pencil_kind\":\"real_frequency_rotated\"") != nullptr,
        "GPU diagnostics must identify the real-frequency-rotated pencil");
    check(
        std::strstr(gpu.diagnostics_json, "\"petsc_vector_type\":\"seqcuda\"") != nullptr,
        "GPU diagnostics must prove CUDA PETSc vectors");
    check(
        std::strstr(gpu.diagnostics_json, "\"slepc_basis_vector_type\":\"seqcuda\"") != nullptr,
        "GPU diagnostics must prove a CUDA-resident SLEPc basis");
    check(
        std::strstr(gpu.diagnostics_json, "\"poisson_pc_type\":\"hypre\"") != nullptr,
        "GPU diagnostics must prove hypre Poisson preconditioning");
    check(
        std::strstr(gpu.diagnostics_json, "\"per_iteration_full_vector_transfers\":0") != nullptr,
        "GPU diagnostics must reject per-iteration full-vector transfers");
    check(
        std::strstr(gpu.diagnostics_json, "\"device_residual_certification\":true") != nullptr,
        "GPU diagnostics must prove device-resident full residual certification");
    check(
        std::strstr(gpu.diagnostics_json, "\"residual_host_vector_reconstruction\":false") != nullptr,
        "GPU diagnostics must reject host residual reconstruction");
    check(
        std::strstr(gpu.diagnostics_json, "\"fallback_used\":false") != nullptr,
        "strict GPU solve must not use CPU fallback");
    check(
        std::strstr(gpu.diagnostics_json, "\"outer_boundary_kind\":\"poisson_robin\"") != nullptr,
        "GPU diagnostics must publish the resolved scalar outer boundary");
    check(
        std::strstr(gpu.diagnostics_json, "\"robin_beta\":1") != nullptr,
        "GPU diagnostics must publish the Robin coefficient");
    check(
        std::strstr(gpu.diagnostics_json, "\"gauge_policy\":\"none\"") != nullptr,
        "GPU diagnostics must publish the resolved gauge policy");
    check(
        std::strstr(gpu.diagnostics_json, "\"gauge_reason\":\"coercive_outer_boundary\"") != nullptr,
        "GPU diagnostics must publish the gauge decision reason");
    check(
        std::strstr(gpu.diagnostics_json, "\"magnetic_block_backward_error\":") != nullptr,
        "GPU diagnostics must publish the magnetic block residual");
    check(
        std::strstr(gpu.diagnostics_json, "\"poisson_block_backward_error\":") != nullptr,
        "GPU diagnostics must publish the Poisson block residual");
    check(
        std::strstr(gpu.diagnostics_json, "\"gauge_constraint_backward_error\":") != nullptr,
        "GPU diagnostics must publish the gauge block residual");
    check(
        std::strstr(gpu.diagnostics_json, "\"action_residual_evaluated_count\":") != nullptr,
        "GPU diagnostics must publish action residual evaluation count");
    check(
        std::strstr(gpu.diagnostics_json, "\"full_residual_accepted_count\":") != nullptr,
        "GPU diagnostics must publish full residual acceptance count");
    check(
        std::strstr(gpu.diagnostics_json, "\"block_residuals\":{") != nullptr,
        "GPU diagnostics must publish the block residual object");
    check(
        std::strstr(gpu.diagnostics_json, "\"boundary_gauge\":{") != nullptr,
        "GPU diagnostics must publish the boundary/gauge object");
    check(
        std::strstr(gpu.diagnostics_json, "\"certification\":{") != nullptr,
        "GPU diagnostics must publish the certification object");
    check(
        std::strstr(gpu.diagnostics_json, "\"production_shared_domain\":false") != nullptr,
        "bounded GPU algebraic adapter must not claim production shared-domain FEM");
    check(
        std::strstr(gpu.diagnostics_json, "\"execution_lane\":\"validation_gpu\"") != nullptr,
        "bounded GPU algebraic adapter must identify the validation execution lane");
    check(
        std::strstr(gpu.diagnostics_json, "\"production_implication\":false") != nullptr,
        "bounded GPU algebraic adapter must not publish production implication");
    check(
        std::strstr(gpu.diagnostics_json, "\"validation_only\":true") != nullptr,
        "bounded GPU algebraic adapter must identify validation-only provenance");
    check(
        std::strstr(gpu.diagnostics_json, "\"scalable_selected_spectrum\":false") != nullptr,
        "bounded materialized GPU adapter must not claim scalable selected spectrum");
    check(
        std::strstr(gpu.diagnostics_json, "\"true_residual_convergence\":true") != nullptr,
        "GPU SLEPc solve must use explicit true residual convergence");
    check(
        std::strstr(gpu.diagnostics_json, "\"eps_converged_reason\":") != nullptr &&
            std::strstr(gpu.diagnostics_json, "\"eps_reason_available\":true") != nullptr,
        "GPU diagnostics must publish the queried EPS convergence reason");
    check(
        std::strstr(gpu.diagnostics_json, "\"operator_apply_count\":") != nullptr &&
            std::strstr(gpu.diagnostics_json, "\"poisson_iteration_count\":") != nullptr,
        "GPU diagnostics must publish measured operator and Poisson iteration counters");
    check(
        std::strstr(
            gpu.diagnostics_json,
            "\"eigensolver_operator_kind\":\"materialized_schur_cuda\"") != nullptr,
        "bounded GPU qualification solve must use the materialized CUDA Schur operator");
    check(
        std::strcmp(
            gpu.shifted_preconditioner_kind,
            "materialized_shifted_schur_cuda") == 0,
        "bounded GPU qualification solve must report its materialized shifted preconditioner");
    check(
        std::strstr(gpu.diagnostics_json, "\"shift_pc_type\":\"ilu\"") != nullptr,
        "materialized GPU shifted solve must use CUDA ILU preconditioning");

    constexpr std::uint64_t scaled_block_count = 12;
    constexpr std::uint64_t scaled_dof_count = 2 * scaled_block_count;
    std::vector<double> scaled_a_qq(scaled_dof_count * scaled_dof_count, 0.0);
    std::vector<double> scaled_a_qphi(scaled_dof_count * scaled_dof_count, 0.0);
    std::vector<double> scaled_a_phiq(scaled_dof_count * scaled_dof_count, 0.0);
    std::vector<double> scaled_a_phiphi(scaled_dof_count * scaled_dof_count, 0.0);
    std::vector<double> scaled_b_qq(scaled_dof_count * scaled_dof_count, 0.0);
    for (std::uint64_t block = 0; block < scaled_block_count; ++block) {
        const std::uint64_t first = 2 * block;
        const std::uint64_t second = first + 1;
        const double block_frequency_hz = 1.0e9 + 0.5e9 * static_cast<double>(block);
        const double block_omega = two_pi * block_frequency_hz;
        scaled_a_qq[first * scaled_dof_count + second] = -pencil_scale * block_omega;
        scaled_a_qq[second * scaled_dof_count + first] = pencil_scale * block_omega;
        scaled_a_qphi[first * scaled_dof_count + first] = -pencil_scale * 1.5e8;
        scaled_a_qphi[first * scaled_dof_count + second] = pencil_scale * 1.5e8;
        scaled_a_phiq[first * scaled_dof_count + second] = -pencil_scale;
        scaled_a_phiq[second * scaled_dof_count + second] = pencil_scale;
        scaled_a_phiphi[first * scaled_dof_count + first] = 2.0 * pencil_scale;
        scaled_a_phiphi[first * scaled_dof_count + second] = -pencil_scale;
        scaled_a_phiphi[second * scaled_dof_count + first] = -pencil_scale;
        scaled_a_phiphi[second * scaled_dof_count + second] = 2.0 * pencil_scale;
        scaled_b_qq[first * scaled_dof_count + first] = pencil_scale;
        scaled_b_qq[second * scaled_dof_count + second] = pencil_scale;
    }
    const CsrOwned block_a_qq = dense_to_csr(
        scaled_dof_count, scaled_dof_count, scaled_a_qq.data());
    const CsrOwned block_a_qphi = dense_to_csr(
        scaled_dof_count, scaled_dof_count, scaled_a_qphi.data());
    const CsrOwned block_a_phiq = dense_to_csr(
        scaled_dof_count, scaled_dof_count, scaled_a_phiq.data());
    const CsrOwned block_a_phiphi = dense_to_csr(
        scaled_dof_count, scaled_dof_count, scaled_a_phiphi.data());
    const CsrOwned block_b_qq = dense_to_csr(
        scaled_dof_count, scaled_dof_count, scaled_b_qq.data());
    fd::PoissonAirboxEigenBlockProblem scaled_problem = problem;
    scaled_problem.q_dof_count = scaled_dof_count;
    scaled_problem.phi_dof_count = scaled_dof_count;
    scaled_problem.A_qq = block_a_qq.view();
    scaled_problem.A_qphi = block_a_qphi.view();
    scaled_problem.A_phiq = block_a_phiq.view();
    scaled_problem.A_phiphi = block_a_phiphi.view();
    scaled_problem.B_qq = block_b_qq.view();
    gpu = {};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(scaled_problem, &gpu) ==
            fd::FrequencyDomainStatus::ok,
        gpu.error_message);
    check(gpu.full_residual_certified,
          "SI-scaled GPU pencil must certify the full descriptor residual");
    check(
        std::abs(gpu.frequency_hz - scaled_problem.target_frequency_hz) <=
            0.05 * scaled_problem.target_frequency_hz,
        "SI-scaled GPU pencil must retain the targeted physical frequency");

    problem.target_kind = "frequency_window";
    problem.frequency_min_hz = 1.0e9;
    problem.frequency_max_hz = 3.0e9;
    problem.requested_mode_count = 1;
    gpu = {};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(problem, &gpu) ==
            fd::FrequencyDomainStatus::ok,
        gpu.error_message);
    check(gpu.accepted_mode_count == 1,
          "GPU multi-shift window must collapse repeated physical branches");
    check(gpu.frequency_hz >= problem.frequency_min_hz &&
              gpu.frequency_hz <= problem.frequency_max_hz,
          "GPU multi-shift window must publish an in-window mode");
    check(std::strstr(gpu.executed_subwindows_json, "\"subwindow_index\":15") != nullptr,
          "GPU frequency-window solve must record every executed subwindow");

    // A complete window may not silently publish fewer modes than requested.
    problem.requested_mode_count = 2;
    gpu = {};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(problem, &gpu) ==
            fd::FrequencyDomainStatus::solve_error,
        "GPU frequency window must fail closed when requested coverage is incomplete");
    check(
        std::strstr(gpu.diagnostics_json, "\"complete\":false") != nullptr,
        "incomplete GPU frequency window must not be marked complete");
    check(
        std::strstr(gpu.diagnostics_json, "\"eps_stop_reason\":\"incomplete_window\"") !=
                nullptr ||
            std::strstr(gpu.diagnostics_json, "\"eps_stop_reason\":\"failed_subwindow\"") !=
                nullptr,
        "incomplete GPU frequency window must publish a stable stop reason");

    problem.frequency_min_hz = 10.0e9;
    problem.frequency_max_hz = 11.0e9;
    gpu = {};
    check(
        fd::solve_poisson_airbox_modal_eigen_gpu_petsc_slepc(problem, &gpu) ==
            fd::FrequencyDomainStatus::solve_error,
        "an empty GPU frequency window must fail closed");
    check(gpu.status == fd::FrequencyDomainStatus::solve_error,
          "empty GPU window result must retain solve_error status");
    check(gpu.accepted_modes.empty() && gpu.accepted_mode_count == 0,
          "empty GPU window must not publish a candidate mode");
    check(!gpu.window_complete,
          "empty GPU window must not publish a complete spectrum");
    check(
        std::strstr(gpu.diagnostics_json, "\"status\":\"failed\",\"complete\":false") !=
            nullptr,
        "empty GPU window diagnostics must publish a failed incomplete result");
    check(gpu.converged_eigenpair_count > 0,
          "failed GPU window must retain converged subwindow counts");
    check(std::strstr(gpu.executed_subwindows_json, "\"subwindow_index\":15") != nullptr,
          "failed GPU window must retain every subwindow diagnostic");
    check(std::strstr(gpu.diagnostics_json, "\"executed_subwindows\":[") != nullptr,
          "failed GPU window diagnostics must expose executed subwindows");
    check(
        std::strstr(gpu.diagnostics_json, "gpu_frequency_window_no_certified_mode") != nullptr,
        "empty GPU window diagnostics must expose the stable failure reason");
    check(
        fd::finalize_poisson_airbox_modal_eigen_gpu_petsc_slepc_runtime() ==
            fd::FrequencyDomainStatus::ok,
        "owned GPU SLEPc runtime finalization must succeed");
}

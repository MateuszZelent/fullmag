#include "cpu/frequency_domain/modal/floquet_modal_solver.hpp"
#include "cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp"

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <vector>

#ifndef FULLMAG_FEM_WITH_SLEPC
#define FULLMAG_FEM_WITH_SLEPC 0
#endif

namespace fd = fullmag::fem::frequency_domain;

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

fd::ModalEigenRequest valid_request()
{
    static double k[3] = {1.0, 0.0, 0.0};
    static fd::FrequencyDomainFloquetPeriodicPair pair{};
    static const char diagnostics[] =
        "{\"payload_kind\":\"bloch_floquet_tangent_operator\"}";
    static double dynamic[4] = {0.25, 0.0, 0.0, 0.25};
    fd::ModalEigenRequest request{};
    request.operator_request.spin_wave_bc_kind = "floquet";
    request.operator_request.k_vector_rad_m = k;
    request.operator_request.k_vector_len = 3;
    request.operator_request.operator_diagnostics_json = diagnostics;
    request.operator_request.include_demag = 1;
    request.floquet_periodic_pairs = &pair;
    request.floquet_periodic_pair_count = 1;
    request.dynamic_demag_k_tangent_matrix_row_major = dynamic;
    request.dynamic_demag_k_tangent_matrix_value_count = 4;
    request.execution_target = fd::ModalExecutionTarget::production_cpu;
    return request;
}

fd::SLEPcTinyGyrotropicModalEigenRequest spectral_request()
{
    static double stiffness[4] = {2.0, 0.0, 0.0, 2.0};
    static double gyrotropic[4] = {0.0, -1.0, 1.0, 0.0};
    fd::SLEPcTinyGyrotropicModalEigenRequest request{};
    request.tangent_dof_count = 2;
    request.stiffness_matrix_row_major = stiffness;
    request.gyrotropic_matrix_row_major = gyrotropic;
    request.requested_mode_count = 1;
    return request;
}

fd::SLEPcSparseGyrotropicModalEigenRequest sparse_spectral_request()
{
    static std::uint32_t row_offsets[3] = {0u, 2u, 4u};
    static std::uint32_t column_indices[4] = {0u, 1u, 0u, 1u};
    static double values[4] = {2.0, 0.0, 0.0, 2.0};
    static double gyrotropic_values[4] = {0.0, -1.0, 1.0, 0.0};
    fd::SLEPcSparseGyrotropicModalEigenRequest request{};
    request.tangent_dof_count = 2;
    request.stiffness_csr = {2, 2, row_offsets, 3, column_indices, 4, values, 4};
    request.gyrotropic_csr = {
        2, 2, row_offsets, 3, column_indices, 4, gyrotropic_values, 4};
    request.requested_mode_count = 1;
    return request;
}

void accepts_finite_nonzero_k_cpu_contract()
{
    const fd::FloquetModalSolverAdmission admission =
        fd::admit_floquet_modal_request(valid_request(), spectral_request());
    check(admission.accepted, "valid Floquet modal request is admitted");
    check(admission.nonzero_k, "admission records a nonzero wavevector");
    check(admission.dynamic_demag_k, "admission records dynamic demag-k");
    check(std::strcmp(admission.reason, "accepted_floquet_cpu_slepc") == 0,
          "admission reason is stable");
    check(std::strcmp(fd::floquet_modal_solver_model(), "floquet_real_frequency_slepc") == 0,
          "Floquet solver model is stable");
}

void rejects_missing_dynamic_payload_and_gpu()
{
    fd::ModalEigenRequest request = valid_request();
    request.dynamic_demag_k_tangent_matrix_row_major = nullptr;
    request.dynamic_demag_k_tangent_matrix_value_count = 0;
    auto admission = fd::admit_floquet_modal_request(request, spectral_request());
    check(!admission.accepted, "demag Floquet request without k payload is rejected");
    check(std::strcmp(admission.reason, "floquet_modal_requires_dynamic_demag_k_payload") == 0,
          "missing dynamic demag reason is stable");

    request = valid_request();
    request.execution_target = fd::ModalExecutionTarget::production_gpu;
    admission = fd::admit_floquet_modal_request(request, spectral_request());
    check(!admission.accepted, "CPU Floquet owner rejects forced GPU");
    check(std::strcmp(admission.reason, "floquet_modal_gpu_lane_not_owned_by_cpu_solver") == 0,
          "forced GPU rejection reason is stable");

    const auto result = fd::solve_floquet_modal_spectrum(request, spectral_request());
    check(std::strcmp(result.status, "validation_error") == 0,
          "rejected Floquet request never reaches the spectral adapter");
    check(std::strcmp(result.unsupported_reason,
                      "floquet_modal_gpu_lane_not_owned_by_cpu_solver") == 0,
          "solver propagates the admission reason");

    request = valid_request();
    request.dynamic_demag_k_tangent_matrix_value_count = 3;
    admission = fd::admit_floquet_modal_request(request, spectral_request());
    check(!admission.accepted, "non-square dynamic demag payload is rejected");
    check(std::strcmp(
              admission.reason,
              "floquet_modal_requires_finite_square_dynamic_demag_k_payload") == 0,
          "dynamic demag shape rejection reason is stable");

    static double nan_dynamic[4] = {0.25, 0.0, 0.0, NAN};
    request = valid_request();
    request.dynamic_demag_k_tangent_matrix_row_major = nan_dynamic;
    admission = fd::admit_floquet_modal_request(request, spectral_request());
    check(!admission.accepted, "non-finite dynamic demag payload is rejected");
}

void rejects_zero_k_and_missing_pairs()
{
    fd::ModalEigenRequest request = valid_request();
    static double zero_k[3] = {0.0, 0.0, 0.0};
    request.operator_request.k_vector_rad_m = zero_k;
    auto admission = fd::admit_floquet_modal_request(request, spectral_request());
    check(!admission.accepted, "zero-k request is not admitted by Floquet owner");
    check(std::strcmp(admission.reason, "floquet_modal_requires_finite_nonzero_three_vector") == 0,
          "zero-k rejection reason is stable");

    request = valid_request();
    request.floquet_periodic_pairs = nullptr;
    request.floquet_periodic_pair_count = 0;
    admission = fd::admit_floquet_modal_request(request, spectral_request());
    check(!admission.accepted, "Floquet request without seam pairs is rejected");
    check(std::strcmp(admission.reason, "floquet_modal_requires_periodic_pair_payload") == 0,
          "missing seam-pair rejection reason is stable");
}

void rejects_conflicting_k_payloads()
{
    fd::ModalEigenRequest request = valid_request();
    static double operator_k[3] = {1.0, 0.0, 0.0};
    request.has_floquet_k_vector = true;
    request.floquet_k_vector_rad_per_m[0] = 2.0;
    request.floquet_k_vector_rad_per_m[1] = 0.0;
    request.floquet_k_vector_rad_per_m[2] = 0.0;
    request.operator_request.k_vector_rad_m = operator_k;
    request.operator_request.k_vector_len = 3;
    const auto admission = fd::admit_floquet_modal_request(request, spectral_request());
    check(!admission.accepted, "conflicting Floquet k payloads are rejected");
    check(std::strcmp(admission.reason, "floquet_modal_k_vector_payload_mismatch") == 0,
          "conflicting Floquet k reason is stable");
}

void rejects_invalid_frequency_windows()
{
    fd::ModalEigenRequest request = valid_request();
    auto spectral = spectral_request();
    spectral.frequency_min_hz = 2.0;
    spectral.frequency_max_hz = 1.0;
    auto admission = fd::admit_floquet_modal_request(request, spectral);
    check(!admission.accepted, "reversed Floquet frequency window is rejected");
    check(std::strcmp(admission.reason,
                      "floquet_modal_requires_valid_frequency_window") == 0,
          "invalid frequency window reason is stable");

    spectral = spectral_request();
    spectral.frequency_min_hz = -1.0;
    spectral.frequency_max_hz = 1.0;
    admission = fd::admit_floquet_modal_request(request, spectral);
    check(!admission.accepted, "negative Floquet frequency window is rejected");

    spectral = spectral_request();
    spectral.frequency_min_hz = 1.0;
    spectral.frequency_max_hz = 2.0;
    admission = fd::admit_floquet_modal_request(request, spectral);
    check(admission.accepted, "finite positive Floquet frequency window is admitted");
    check(admission.frequency_window, "admission records a selected frequency window");
}

void admits_sparse_bloch_operator_without_demag()
{
    fd::ModalEigenRequest request = valid_request();
    request.operator_request.include_demag = 0;
    request.mfem_sparse_operator_enabled = 1;
    const auto admission = fd::admit_floquet_modal_sparse_request(
        request, sparse_spectral_request());
    check(admission.accepted, "sparse Floquet operator is admitted without demag");
    check(!admission.dynamic_demag_k, "sparse no-demag route has no demag-k term");
    check(std::strcmp(admission.reason, "accepted_floquet_cpu_sparse_slepc") == 0,
          "sparse admission reason is stable");

    request.operator_request.include_demag = 1;
    const auto demag_admission = fd::admit_floquet_modal_sparse_request(
        request, sparse_spectral_request());
    check(!demag_admission.accepted,
          "sparse Floquet owner rejects a dynamic demag request");
    check(std::strcmp(
              demag_admission.reason,
              "floquet_sparse_modal_requires_shared_domain_sparse_owner") == 0,
          "sparse dynamic demag rejection reason is stable");
}

fd::PoissonAirboxSharedDomainComplexCsrMatrix diagonal_complex_csr(
    std::size_t dimension,
    const std::vector<std::complex<double>> &diagonal)
{
    check(dimension == diagonal.size(), "diagonal fixture has matching dimensions");
    fd::PoissonAirboxSharedDomainComplexCsrMatrix matrix{};
    matrix.row_count = dimension;
    matrix.column_count = dimension;
    matrix.row_offsets.reserve(dimension + 1u);
    matrix.column_indices.reserve(dimension);
    matrix.values.reserve(dimension);
    matrix.row_offsets.push_back(0u);
    for (std::size_t row = 0u; row < dimension; ++row) {
        matrix.column_indices.push_back(static_cast<std::uint32_t>(row));
        matrix.values.push_back(diagonal[row]);
        matrix.row_offsets.push_back(static_cast<std::uint32_t>(matrix.values.size()));
    }
    return matrix;
}

fd::PoissonAirboxSharedDomainComplexCsrMatrix q_to_phi_complex_csr(
    std::size_t q_dimension,
    std::complex<double> coupling)
{
    fd::PoissonAirboxSharedDomainComplexCsrMatrix matrix{};
    matrix.row_count = q_dimension;
    matrix.column_count = 1u;
    matrix.row_offsets.reserve(q_dimension + 1u);
    matrix.row_offsets.push_back(0u);
    for (std::size_t row = 0u; row < q_dimension; ++row) {
        if (row == 0u) {
            matrix.column_indices.push_back(0u);
            matrix.values.push_back(coupling);
        }
        matrix.row_offsets.push_back(static_cast<std::uint32_t>(matrix.values.size()));
    }
    return matrix;
}

fd::PoissonAirboxSharedDomainComplexCsrMatrix phi_to_q_complex_csr(
    std::size_t q_dimension,
    std::complex<double> coupling)
{
    fd::PoissonAirboxSharedDomainComplexCsrMatrix matrix{};
    matrix.row_count = 1u;
    matrix.column_count = q_dimension;
    matrix.row_offsets = {0u, 1u};
    matrix.column_indices = {0u};
    matrix.values = {coupling};
    return matrix;
}

std::vector<std::complex<double>> complex_csr_matvec_for_test(
    const fd::PoissonAirboxSharedDomainComplexCsrMatrix &matrix,
    const std::vector<std::complex<double>> &vector)
{
    check(matrix.column_count == vector.size(), "fixture CSR matvec dimensions match");
    std::vector<std::complex<double>> result(
        static_cast<std::size_t>(matrix.row_count), std::complex<double>{});
    for (std::uint64_t row = 0u; row < matrix.row_count; ++row) {
        for (std::uint32_t entry = matrix.row_offsets[static_cast<std::size_t>(row)];
             entry < matrix.row_offsets[static_cast<std::size_t>(row + 1u)];
             ++entry) {
            result[static_cast<std::size_t>(row)] +=
                matrix.values[entry] *
                vector[static_cast<std::size_t>(matrix.column_indices[entry])];
        }
    }
    return result;
}

double complex_norm_for_test(const std::vector<std::complex<double>> &vector)
{
    long double sum = 0.0L;
    for (const auto value : vector) {
        sum += static_cast<long double>(std::norm(value));
    }
    return std::sqrt(static_cast<double>(sum));
}

void admits_certified_shared_domain_sparse_operator()
{
    const auto a_qq = diagonal_complex_csr(2u, {2.0, 3.0});
    const auto b_qq = diagonal_complex_csr(2u, {1.0, 1.0});
    const auto p = diagonal_complex_csr(1u, {1.0});
    const auto a_qphi = q_to_phi_complex_csr(2u, 0.25);
    const auto a_phiq = phi_to_q_complex_csr(2u, 0.25);
    fd::FloquetSharedDomainSparseModalOperator operator_view{};
    operator_view.a_qq = &a_qq;
    operator_view.b_qq = &b_qq;
    operator_view.p = &p;
    operator_view.a_qphi = &a_qphi;
    operator_view.a_phiq = &a_phiq;
    operator_view.q_complex_dof_count = 2u;
    operator_view.phi_dof_count = 1u;

    fd::ModalEigenRequest request = valid_request();
    request.operator_request.operator_diagnostics_json =
        "{\"payload_kind\":\"certified_shared_domain\"}";
    request.dynamic_demag_k_tangent_matrix_row_major = nullptr;
    request.dynamic_demag_k_tangent_matrix_value_count = 0u;
    request.floquet_shared_domain_operator = &operator_view;
    auto spectral = sparse_spectral_request();
    spectral.floquet_shared_domain_operator = &operator_view;

    auto admission = fd::admit_floquet_modal_sparse_request(request, spectral);
    check(admission.accepted,
          "certified shared-domain Floquet operator reaches sparse SLEPc admission");
    check(admission.dynamic_demag_k,
          "shared-domain Floquet admission retains dynamic demag-k");

    request.operator_request.operator_diagnostics_json =
        "{\"payload_kind\":\"bloch_floquet_tangent_operator\"}";
    admission = fd::admit_floquet_modal_sparse_request(request, spectral);
    check(!admission.accepted,
          "shared-domain owner rejects a mismatched dense operator marker");

    request.operator_request.operator_diagnostics_json =
        "{\"payload_kind\":\"certified_shared_domain\"}";
    request.floquet_shared_domain_operator = nullptr;
    admission = fd::admit_floquet_modal_sparse_request(request, spectral);
    check(!admission.accepted,
          "shared-domain marker without its operator payload is rejected");
}

void executes_native_sparse_matshell_above_dense_bound()
{
    constexpr std::size_t q_dimension = 514u;
    // Keep the synthetic fixture above the shared numerical-zero policy
    // (1e5 rad/s, approximately 15.9 kHz).  The production dispersion
    // window is in the GHz range; using 1 kHz here made a valid positive mode
    // look like a numerical zero and caused the contract to reject it.
    constexpr double expected_frequency_hz = 1.0e6;
    // Keep the shift off the exact synthetic eigenvalue.  STSINVERT factors
    // (A - sigma B), which is singular when sigma equals the fixture's mode;
    // 100 Hz remains closer to row 0 than the 400 Hz row spacing and therefore
    // keeps mode selection deterministic while exercising the shifted solve.
    constexpr double target_frequency_hz = 1.0001e6;
    const double expected_omega = fd::omega_rad_s_from_frequency_hz(expected_frequency_hz);
    const std::complex<double> q_phi_coupling(0.25, 0.0);
    const std::complex<double> phi_q_coupling(0.25, 0.0);

    // a_qq models the Hermitian magnetic-Hessian block (K + D), which has a
    // REAL diagonal in production (see FIX H3's rotated_a_qq zero-diagonal
    // analysis).  The imaginary "rotate to a real target frequency" factor
    // therefore lives on b_qq's diagonal here instead of a_qq's: for a
    // decoupled diagonal row, (-i*phase_sign*A_eff)/b = mu, and choosing
    // b = -i makes mu = phase_sign*A_eff and lambda_imag = A_eff directly
    // (independent of phase_sign, since phase_sign^2 == 1), so a REAL
    // a_diagonal reproduces exactly the same expected eigenvalues as the
    // previous purely-imaginary construction did.
    std::vector<std::complex<double>> a_diagonal(q_dimension);
    std::vector<std::complex<double>> b_diagonal(
        q_dimension, std::complex<double>(0.0, -1.0));
    a_diagonal[0u] = q_phi_coupling * phi_q_coupling +
        std::complex<double>(expected_omega, 0.0);
    for (std::size_t row = 1u; row < q_dimension; ++row) {
        a_diagonal[row] = std::complex<double>(
            fd::omega_rad_s_from_frequency_hz(
                expected_frequency_hz + 400.0 * static_cast<double>(row)),
            0.0);
    }

    const auto a_qq = diagonal_complex_csr(q_dimension, a_diagonal);
    const auto b_qq = diagonal_complex_csr(q_dimension, b_diagonal);
    const auto p = diagonal_complex_csr(1u, {std::complex<double>(1.0, 0.0)});
    const auto a_qphi = q_to_phi_complex_csr(q_dimension, q_phi_coupling);
    const auto a_phiq = phi_to_q_complex_csr(q_dimension, phi_q_coupling);

    fd::FloquetSharedDomainSparseModalOperator operator_view{};
    operator_view.a_qq = &a_qq;
    operator_view.b_qq = &b_qq;
    operator_view.p = &p;
    operator_view.a_qphi = &a_qphi;
    operator_view.a_phiq = &a_phiq;
    operator_view.q_complex_dof_count = q_dimension;
    operator_view.phi_dof_count = 1u;
    operator_view.boundary_kind = "robin";
    operator_view.gauge_policy = "nonzero_k_invertible_poisson";

    fd::SLEPcSparseGyrotropicModalEigenRequest spectral{};
    spectral.tangent_dof_count = static_cast<int>(q_dimension);
    spectral.requested_mode_count = 1;
    spectral.target_frequency_hz = target_frequency_hz;
    spectral.residual_tolerance = 1.0e-8;
    spectral.max_outer_iterations = 160;
    spectral.max_linear_iterations = 96;

    const auto result = fd::solve_floquet_shared_domain_sparse_modal_spectrum(
        operator_view, spectral);
    check(result.execution_policy != nullptr &&
              std::strcmp(result.execution_policy, "petsc_sequential_cpu") == 0,
          "native Floquet result exposes the sequential PETSc policy");
    check(result.execution_scope != nullptr &&
              std::strcmp(result.execution_scope, "single_process_shared_memory") == 0,
          "native Floquet result exposes its single-process execution scope");
    check(result.communicator != nullptr &&
              std::strcmp(result.communicator, "PETSC_COMM_SELF") == 0,
          "native Floquet result exposes the PETSc communicator");
    check(result.scalability_scope != nullptr &&
              std::strcmp(result.scalability_scope, "single_process_only") == 0,
          "native Floquet result does not claim distributed scalability");
    check(result.poisson_ksp_type != nullptr &&
              std::strcmp(result.poisson_ksp_type, "preonly") == 0 &&
              result.poisson_pc_type != nullptr &&
              std::strcmp(result.poisson_pc_type, "lu") == 0,
          "native Floquet result exposes the Poisson LU policy");
    check(result.poisson_iteration_semantics != nullptr &&
              std::strcmp(
                  result.poisson_iteration_semantics,
                  "preonly_factorization_no_iterative_convergence") == 0,
          "native Floquet result distinguishes Poisson factorization from iteration");
    check(result.ksp_type != nullptr &&
              std::strcmp(result.ksp_type, "gmres") == 0 &&
              result.pc_type != nullptr &&
              std::strcmp(result.pc_type, "lu") == 0 &&
              result.factorization_package != nullptr &&
              std::strcmp(result.factorization_package, "petsc_default_lu") == 0,
          "native Floquet result exposes the shifted GMRES/LU policy");
#if FULLMAG_FEM_WITH_SLEPC
    check(result.ok, result.unsupported_reason);
    check(result.accepted_mode_count == 1,
          "native Floquet MatShell regression accepts one requested mode");
    check(result.solver_adapter != nullptr &&
              std::strcmp(result.solver_adapter, "floquet_airbox_cpu_schur_slepc") == 0,
          "native Floquet MatShell regression reports its native adapter");
    const fd::SLEPcModalAcceptedMode &mode = result.accepted_modes.front();
    check(mode.floquet_mode_vector_physical_complex,
          "native Floquet mode exposes a physical complex q vector");
    check(mode.mode_vector.size() == q_dimension,
          "native Floquet physical q vector has the original complex dimension");
    check(mode.floquet_potential_real_split.size() == 1u,
          "native Floquet mode exposes the physical scalar potential");
    check(std::abs(mode.frequency_hz - expected_frequency_hz) < 1.0e-4,
          "native Floquet mode uses the analytical frequency after rotation");
    check(std::abs(mode.lambda_real) < 1.0e-6 &&
              std::abs(mode.lambda_imag - expected_omega) < 1.0e-3,
          "native Floquet mode restores the canonical lambda=i*omega convention");
    check(!mode.floquet_descriptor_certified,
          "native reduced blocks do not claim full descriptor certification");
    check(std::abs(mode.floquet_potential_real_split[0]) > 1.0e-6,
          "native Floquet scalar potential remains nonzero under coupling");

    const auto a_q_q = complex_csr_matvec_for_test(a_qq, mode.mode_vector);
    const auto a_q_phi = complex_csr_matvec_for_test(
        a_qphi, mode.floquet_potential_real_split);
    const auto b_q = complex_csr_matvec_for_test(b_qq, mode.mode_vector);
    const auto p_phi = complex_csr_matvec_for_test(
        p, mode.floquet_potential_real_split);
    const auto a_phi_q = complex_csr_matvec_for_test(a_phiq, mode.mode_vector);
    std::vector<std::complex<double>> magnetic_residual(q_dimension);
    for (std::size_t index = 0u; index < q_dimension; ++index) {
        magnetic_residual[index] = a_q_q[index] + a_q_phi[index] -
            std::complex<double>(0.0, mode.lambda_imag) * b_q[index];
    }
    const double magnetic_denominator = complex_norm_for_test(a_q_q) +
        complex_norm_for_test(a_q_phi) +
        std::abs(mode.lambda_imag) * complex_norm_for_test(b_q);
    const double magnetic_relative_residual =
        complex_norm_for_test(magnetic_residual) /
        (magnetic_denominator + std::numeric_limits<double>::min());
    check(magnetic_relative_residual < 1.0e-7,
          "native Floquet physical q/phi satisfies the original magnetic block");
    std::vector<std::complex<double>> potential_residual(1u);
    potential_residual[0u] = p_phi[0u] + a_phi_q[0u];
    check(complex_norm_for_test(potential_residual) < 1.0e-7,
          "native Floquet physical q/phi satisfies the original Poisson block");
#else
    check(!result.ok, "native Floquet endpoint stays unavailable without SLEPc");
    check(result.status != nullptr && std::strcmp(result.status, "unavailable") == 0,
          "native Floquet endpoint reports unavailable without SLEPc");
    check(result.unsupported_reason != nullptr &&
              std::strcmp(result.unsupported_reason, "slepc_not_available") == 0,
          "native Floquet endpoint reports the SLEPc capability failure");
#endif
}

void normalizes_si_scale_floquet_pencil()
{
#if FULLMAG_FEM_WITH_SLEPC
    constexpr std::size_t q_dimension = 8u;
    constexpr double coefficient_scale = 1.0e-60;
    constexpr double frequency_hz = 1.0e6;
    std::vector<std::complex<double>> a_diagonal(q_dimension);
    std::vector<std::complex<double>> b_diagonal(
        q_dimension, std::complex<double>(0.0, -coefficient_scale));
    for (std::size_t row = 0u; row < q_dimension; ++row) {
        a_diagonal[row] = coefficient_scale * fd::omega_rad_s_from_frequency_hz(
            frequency_hz + 2.0e5 * static_cast<double>(row));
    }
    const auto a_qq = diagonal_complex_csr(q_dimension, a_diagonal);
    const auto b_qq = diagonal_complex_csr(q_dimension, b_diagonal);
    const auto p = diagonal_complex_csr(1u, {1.0});
    const auto a_qphi = q_to_phi_complex_csr(q_dimension, 0.0);
    const auto a_phiq = phi_to_q_complex_csr(q_dimension, 0.0);
    fd::FloquetSharedDomainSparseModalOperator operator_view{};
    operator_view.a_qq = &a_qq;
    operator_view.b_qq = &b_qq;
    operator_view.p = &p;
    operator_view.a_qphi = &a_qphi;
    operator_view.a_phiq = &a_phiq;
    operator_view.q_complex_dof_count = q_dimension;
    operator_view.phi_dof_count = 1u;

    fd::SLEPcSparseGyrotropicModalEigenRequest request{};
    request.tangent_dof_count = static_cast<int>(q_dimension);
    request.requested_mode_count = 1;
    request.target_frequency_hz = frequency_hz + 1.0e4;
    request.residual_tolerance = 1.0e-8;
    request.max_outer_iterations = 160;
    request.max_linear_iterations = 96;
    const auto result = fd::solve_floquet_shared_domain_sparse_modal_spectrum(
        operator_view, request);
    check(result.operator_normalization_scale > 1.0e40,
          "SI-scale generalized Floquet pencil is normalized before sparse LU");
    check(std::isfinite(result.preconditioner_normalization_scale) &&
              result.preconditioner_normalization_scale > 0.0,
          "shifted preconditioner reports a finite positive normalization");
    check(result.ok, result.unsupported_reason);
    check(std::abs(result.frequency_hz - frequency_hz) < 1.0e-2,
          "pencil scaling preserves the physical eigenfrequency");
#endif
}

} // namespace

int main()
{
    accepts_finite_nonzero_k_cpu_contract();
    rejects_missing_dynamic_payload_and_gpu();
    rejects_zero_k_and_missing_pairs();
    rejects_conflicting_k_payloads();
    rejects_invalid_frequency_windows();
    admits_sparse_bloch_operator_without_demag();
    admits_certified_shared_domain_sparse_operator();
    executes_native_sparse_matshell_above_dense_bound();
    normalizes_si_scale_floquet_pencil();
    return 0;
}

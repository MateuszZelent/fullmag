#include "cpu/frequency_domain/modal/floquet_modal_solver.hpp"

#include <cmath>
#include <complex>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

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
              "floquet_sparse_modal_requires_dense_dynamic_demag_owner") == 0,
          "sparse dynamic demag rejection reason is stable");
}

} // namespace

int main()
{
    accepts_finite_nonzero_k_cpu_contract();
    rejects_missing_dynamic_payload_and_gpu();
    rejects_zero_k_and_missing_pairs();
    admits_sparse_bloch_operator_without_demag();
    return 0;
}

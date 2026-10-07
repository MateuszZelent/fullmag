#include "cpu/frequency_domain/modal/floquet_modal_solver.hpp"
#include "cpu/frequency_domain/modal_krylov_tuning.hpp"
#include "cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <vector>

#ifndef FULLMAG_FEM_WITH_SLEPC
#define FULLMAG_FEM_WITH_SLEPC 0
#endif

#if FULLMAG_FEM_WITH_SLEPC
#include <petscksp.h>
#include <slepceps.h>
#include "cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp"
#endif

namespace fullmag::fem::frequency_domain {
namespace {

// Shared by always-available diagnostics and the optional PETSc implementation.
constexpr double kFloquetShiftedGmresBreakdownTolerance = 2.0;

bool floquet_schur_action_diagnostic_requested() noexcept
{
    const char *value = std::getenv("FULLMAG_FLOQUET_SCHUR_ACTION_DIAGNOSTIC");
    return value != nullptr && std::strcmp(value, "1") == 0;
}

void initialize_floquet_schur_action_diagnostic(
    SLEPcTinyGyrotropicModalEigenResult *result) noexcept
{
    if (result == nullptr || !floquet_schur_action_diagnostic_requested()) {
        return;
    }
    auto &diagnostic = result->floquet_schur_action_diagnostic;
    diagnostic.requested = true;
    diagnostic.available = false;
    diagnostic.status = "unavailable";
    diagnostic.reason = "diagnostic_not_reached_before_solver_setup_failure";
    // These scales are not known until the production pencil and shifted
    // preconditioner have been built. Keep them non-finite so the JSON
    // serializer emits null instead of a fabricated default scale on an
    // early validation/setup return.
    diagnostic.operator_normalization_scale =
        std::numeric_limits<double>::quiet_NaN();
    diagnostic.preconditioner_normalization_scale =
        std::numeric_limits<double>::quiet_NaN();
}

bool finite_nonzero_k(const ModalEigenRequest &request) noexcept
{
    const double *values = request.operator_request.k_vector_rad_m;
    const int length = request.operator_request.k_vector_len;
    const bool use_embedded_vector =
        (values == nullptr || length <= 0) && request.has_floquet_k_vector;
    if (use_embedded_vector) {
        values = request.floquet_k_vector_rad_per_m;
    }
    const int effective_length = use_embedded_vector ? 3 : length;
    if (values == nullptr || effective_length != 3) {
        return false;
    }
    bool nonzero = false;
    for (int index = 0; index < effective_length; ++index) {
        if (!std::isfinite(values[index])) {
            return false;
        }
        nonzero = nonzero || std::abs(values[index]) > 0.0;
    }
    return nonzero;
}

bool floquet_k_payload_is_consistent(const ModalEigenRequest &request) noexcept
{
    if (!request.has_floquet_k_vector) {
        return true;
    }
    const double *operator_values = request.operator_request.k_vector_rad_m;
    const int operator_length = request.operator_request.k_vector_len;
    if (operator_values == nullptr && operator_length <= 0) {
        return true;
    }
    if (operator_values == nullptr || operator_length != 3) {
        return false;
    }
    for (int index = 0; index < 3; ++index) {
        if (!std::isfinite(operator_values[index]) ||
            operator_values[index] != request.floquet_k_vector_rad_per_m[index]) {
            return false;
        }
    }
    return true;
}

bool has_floquet_payload_marker(const ModalEigenRequest &request) noexcept
{
    const char *diagnostics = request.operator_request.operator_diagnostics_json;
    if (diagnostics == nullptr) {
        return false;
    }
    if (request.floquet_shared_domain_operator != nullptr) {
        return std::strstr(
                   diagnostics,
                   "\"payload_kind\":\"certified_shared_domain\"") != nullptr;
    }
    return std::strstr(
               diagnostics,
               "\"payload_kind\":\"bloch_floquet_tangent_operator\"") != nullptr;
}

SLEPcTinyGyrotropicModalEigenResult validation_failure(const char *reason) noexcept
{
    SLEPcTinyGyrotropicModalEigenResult result{};
    result.status = "validation_error";
    result.unsupported_reason = reason != nullptr ? reason : "invalid_floquet_modal_request";
    return result;
}

bool sparse_view_is_valid(const CsrMatrixView &view) noexcept
{
    if (view.row_count == 0 || view.column_count == 0 ||
        view.row_count != view.column_count || view.row_count ==
            std::numeric_limits<std::uint64_t>::max() ||
        view.row_offsets == nullptr ||
        view.row_offsets_len != view.row_count + 1u ||
        view.column_indices == nullptr || view.values == nullptr ||
        view.column_indices_len != view.values_len ||
        view.row_offsets[0] != 0u ||
        view.row_offsets[view.row_count] != view.values_len) {
        return false;
    }
    for (std::uint64_t row = 0; row < view.row_count; ++row) {
        if (view.row_offsets[row] > view.row_offsets[row + 1u]) {
            return false;
        }
    }
    for (std::uint64_t entry = 0; entry < view.values_len; ++entry) {
        if (view.column_indices[entry] >= view.column_count ||
            !std::isfinite(view.values[entry])) {
            return false;
        }
    }
    return true;
}

bool complex_sparse_view_is_valid(
    const PoissonAirboxSharedDomainComplexCsrMatrix *view) noexcept
{
    if (view == nullptr || view->row_count == 0u || view->column_count == 0u ||
        view->row_count == std::numeric_limits<std::uint64_t>::max() ||
        view->row_count > std::numeric_limits<std::size_t>::max() ||
        view->row_offsets.size() !=
            static_cast<std::size_t>(view->row_count + 1u) ||
        view->column_indices.size() != view->values.size() ||
        view->row_offsets.empty() || view->row_offsets.front() != 0u ||
        view->row_offsets.back() != view->values.size()) {
        return false;
    }
    for (std::uint64_t row = 0u; row < view->row_count; ++row) {
        if (view->row_offsets[static_cast<std::size_t>(row)] >
            view->row_offsets[static_cast<std::size_t>(row + 1u)]) {
            return false;
        }
    }
    for (std::size_t index = 0u; index < view->values.size(); ++index) {
        const auto value = view->values[index];
        if (view->column_indices[index] >= view->column_count ||
            !std::isfinite(value.real()) || !std::isfinite(value.imag())) {
            return false;
        }
    }
    return true;
}

const char *floquet_shared_operator_invalid_reason(
    const FloquetSharedDomainSparseModalOperator *operator_view,
    int spectral_dimension) noexcept
{
    if (operator_view == nullptr) {
        return "floquet_shared_domain_operator_missing";
    }
    const bool has_probe_y = operator_view->uniform_transverse_probe_q_y != nullptr;
    const bool has_probe_z = operator_view->uniform_transverse_probe_q_z != nullptr;
    if (operator_view->q_complex_dof_count == 0u) {
        return "floquet_shared_domain_magnetic_dof_count_is_zero";
    }
    if (operator_view->phi_dof_count == 0u) {
        return "floquet_shared_domain_scalar_dof_count_is_zero";
    }
    if (has_probe_y != has_probe_z) {
        return "floquet_shared_domain_demag_probe_pair_is_incomplete";
    }
    if (has_probe_y &&
        (operator_view->uniform_transverse_probe_q_y->size() !=
             operator_view->q_complex_dof_count ||
         operator_view->uniform_transverse_probe_q_z->size() !=
             operator_view->q_complex_dof_count)) {
        return "floquet_shared_domain_demag_probe_shape_mismatch";
    }
    if (has_probe_y &&
        (!std::all_of(
             operator_view->uniform_transverse_probe_q_y->begin(),
             operator_view->uniform_transverse_probe_q_y->end(),
             [](double value) { return std::isfinite(value); }) ||
         !std::all_of(
             operator_view->uniform_transverse_probe_q_z->begin(),
             operator_view->uniform_transverse_probe_q_z->end(),
             [](double value) { return std::isfinite(value); }))) {
        return "floquet_shared_domain_demag_probe_contains_nonfinite_values";
    }
    if (has_probe_y &&
        (!std::isfinite(operator_view->mu0_T_m_A) ||
         operator_view->mu0_T_m_A <= 0.0)) {
        return "floquet_shared_domain_demag_probe_requires_positive_mu0";
    }
    if (operator_view->q_complex_dof_count >
            static_cast<std::uint64_t>(std::numeric_limits<int>::max() / 2) ||
        operator_view->phi_dof_count >
            static_cast<std::uint64_t>(std::numeric_limits<int>::max() / 2)) {
        return "floquet_shared_domain_dof_count_exceeds_slepc_limit";
    }
    if (spectral_dimension !=
            static_cast<int>(operator_view->q_complex_dof_count) &&
        spectral_dimension !=
            static_cast<int>(2u * operator_view->q_complex_dof_count)) {
        return "floquet_shared_domain_spectral_dimension_mismatch";
    }
    if (!complex_sparse_view_is_valid(operator_view->a_qq)) {
        return "floquet_shared_domain_a_qq_csr_is_invalid";
    }
    if (!complex_sparse_view_is_valid(operator_view->b_qq)) {
        return "floquet_shared_domain_b_qq_csr_is_invalid";
    }
    if (!complex_sparse_view_is_valid(operator_view->p)) {
        return "floquet_shared_domain_p_csr_is_invalid";
    }
    if (!complex_sparse_view_is_valid(operator_view->a_qphi)) {
        return "floquet_shared_domain_a_qphi_csr_is_invalid";
    }
    if (!complex_sparse_view_is_valid(operator_view->a_phiq)) {
        return "floquet_shared_domain_a_phiq_csr_is_invalid";
    }
    const std::uint64_t q = operator_view->q_complex_dof_count;
    const std::uint64_t phi = operator_view->phi_dof_count;
    if (operator_view->a_qq->row_count != q ||
        operator_view->a_qq->column_count != q) {
        return "floquet_shared_domain_a_qq_dimension_mismatch";
    }
    if (operator_view->b_qq->row_count != q ||
        operator_view->b_qq->column_count != q) {
        return "floquet_shared_domain_b_qq_dimension_mismatch";
    }
    if (operator_view->p->row_count != phi ||
        operator_view->p->column_count != phi) {
        return "floquet_shared_domain_p_dimension_mismatch";
    }
    if (operator_view->a_qphi->row_count != q ||
        operator_view->a_qphi->column_count != phi) {
        return "floquet_shared_domain_a_qphi_dimension_mismatch";
    }
    if (operator_view->a_phiq->row_count != phi ||
        operator_view->a_phiq->column_count != q) {
        return "floquet_shared_domain_a_phiq_dimension_mismatch";
    }
    return nullptr;
}

bool dense_matrix_payload_is_valid(
    const double *values,
    std::uint64_t value_count,
    int dimension) noexcept
{
    if (values == nullptr || dimension <= 0) {
        return false;
    }
    const std::uint64_t n = static_cast<std::uint64_t>(dimension);
    if (n > std::numeric_limits<std::uint64_t>::max() / n ||
        value_count != n * n) {
        return false;
    }
    for (std::uint64_t index = 0; index < value_count; ++index) {
        if (!std::isfinite(values[index])) {
            return false;
        }
    }
    return true;
}

bool frequency_window_is_valid(
    const SLEPcTinyGyrotropicModalEigenRequest &request,
    bool *out_has_window) noexcept
{
    if (out_has_window == nullptr ||
        !std::isfinite(request.frequency_min_hz) ||
        !std::isfinite(request.frequency_max_hz) ||
        !std::isfinite(request.target_frequency_hz) ||
        request.frequency_min_hz < 0.0 ||
        request.frequency_max_hz < 0.0 ||
        request.target_frequency_hz < 0.0) {
        return false;
    }
    const bool no_window = request.frequency_min_hz == 0.0 &&
        request.frequency_max_hz == 0.0;
    if (!no_window &&
        !(request.frequency_max_hz > request.frequency_min_hz)) {
        return false;
    }
    *out_has_window = !no_window;
    return true;
}

bool frequency_window_is_valid(
    const SLEPcSparseGyrotropicModalEigenRequest &request,
    bool *out_has_window) noexcept
{
    if (out_has_window == nullptr ||
        !std::isfinite(request.frequency_min_hz) ||
        !std::isfinite(request.frequency_max_hz) ||
        !std::isfinite(request.target_frequency_hz) ||
        request.frequency_min_hz < 0.0 ||
        request.frequency_max_hz < 0.0 ||
        request.target_frequency_hz < 0.0) {
        return false;
    }
    const bool no_window = request.frequency_min_hz == 0.0 &&
        request.frequency_max_hz == 0.0;
    if (!no_window &&
        !(request.frequency_max_hz > request.frequency_min_hz)) {
        return false;
    }
    *out_has_window = !no_window;
    return true;
}

using Complex = std::complex<double>;

// The DE minimal-validation plan uses 1e-8 as the original-equation
// acceptance threshold for both the potential solve and the physical Schur
// energy checks. Keep this separate from EPS's transformed-pencil tolerance.
constexpr double kFloquetDemagProbeRelativeTolerance = 1.0e-8;
constexpr double kFloquetEpsTrueResidualSafetyFactor = 1.0e-3;

std::vector<Complex> complex_csr_matvec(
    const PoissonAirboxSharedDomainComplexCsrMatrix &matrix,
    const std::vector<Complex> &x)
{
    std::vector<Complex> result(static_cast<std::size_t>(matrix.row_count), Complex{});
    if (matrix.column_count != x.size()) {
        return {};
    }
    for (std::uint64_t row = 0u; row < matrix.row_count; ++row) {
        Complex value{};
        for (std::uint32_t entry = matrix.row_offsets[static_cast<std::size_t>(row)];
             entry < matrix.row_offsets[static_cast<std::size_t>(row + 1u)];
             ++entry) {
            value += matrix.values[entry] *
                x[static_cast<std::size_t>(matrix.column_indices[entry])];
        }
        result[static_cast<std::size_t>(row)] = value;
    }
    return result;
}

double complex_vector_norm(const std::vector<Complex> &values) noexcept
{
    long double sum = 0.0L;
    for (const Complex value : values) {
        sum += static_cast<long double>(std::norm(value));
    }
    const double norm = std::sqrt(static_cast<double>(sum));
    return std::isfinite(norm) ? norm : std::numeric_limits<double>::infinity();
}

std::vector<Complex> physical_complex_vector_from_split(
    const std::vector<Complex> &split,
    std::uint64_t physical_count)
{
    if (physical_count == 0u ||
        split.size() != static_cast<std::size_t>(2u * physical_count)) {
        return {};
    }
    std::vector<Complex> result(static_cast<std::size_t>(physical_count), Complex{});
    for (std::uint64_t index = 0u; index < physical_count; ++index) {
        result[static_cast<std::size_t>(index)] =
            split[static_cast<std::size_t>(index)] +
            Complex(0.0, 1.0) *
                split[static_cast<std::size_t>(physical_count + index)];
    }
    return result;
}

double floquet_magnetic_residual(
    const FloquetSharedDomainSparseModalOperator &operator_view,
    const std::vector<Complex> &q,
    const std::vector<Complex> &phi,
    Complex lambda) noexcept
{
    const std::vector<Complex> a_qq_q = complex_csr_matvec(*operator_view.a_qq, q);
    const std::vector<Complex> a_qphi_phi =
        complex_csr_matvec(*operator_view.a_qphi, phi);
    const std::vector<Complex> b_q = complex_csr_matvec(*operator_view.b_qq, q);
    if (a_qq_q.size() != q.size() || a_qphi_phi.size() != q.size() ||
        b_q.size() != q.size()) {
        return std::numeric_limits<double>::infinity();
    }
    std::vector<Complex> residual(q.size(), Complex{});
    double denominator = 0.0;
    for (std::size_t index = 0u; index < q.size(); ++index) {
        residual[index] = a_qq_q[index] + a_qphi_phi[index] - lambda * b_q[index];
    }
    denominator = complex_vector_norm(a_qq_q) + complex_vector_norm(a_qphi_phi) +
        std::abs(lambda) * complex_vector_norm(b_q);
    return complex_vector_norm(residual) /
        (denominator + std::numeric_limits<double>::min());
}

double floquet_potential_residual(
    const FloquetSharedDomainSparseModalOperator &operator_view,
    const std::vector<Complex> &q,
    const std::vector<Complex> &phi) noexcept
{
    const std::vector<Complex> p_phi = complex_csr_matvec(*operator_view.p, phi);
    const std::vector<Complex> a_phiq_q = complex_csr_matvec(*operator_view.a_phiq, q);
    if (p_phi.size() != phi.size() || a_phiq_q.size() != phi.size()) {
        return std::numeric_limits<double>::infinity();
    }
    std::vector<Complex> residual(phi.size(), Complex{});
    for (std::size_t index = 0u; index < phi.size(); ++index) {
        residual[index] = p_phi[index] + a_phiq_q[index];
    }
    return complex_vector_norm(residual) /
        (complex_vector_norm(p_phi) + complex_vector_norm(a_phiq_q) +
         std::numeric_limits<double>::min());
}

#if FULLMAG_HAS_MFEM_STACK

std::vector<Complex> real_csr_matvec(
    const PoissonAirboxSharedDomainCsrMatrix &matrix,
    const std::vector<Complex> &x)
{
    if (matrix.row_count == 0u || matrix.column_count != x.size() ||
        matrix.row_offsets.size() != static_cast<std::size_t>(matrix.row_count + 1u) ||
        matrix.column_indices.size() != matrix.values.size() ||
        matrix.row_offsets.empty() || matrix.row_offsets.front() != 0u ||
        matrix.row_offsets.back() != matrix.values.size()) {
        return {};
    }
    std::vector<Complex> result(static_cast<std::size_t>(matrix.row_count), Complex{});
    for (std::uint64_t row = 0u; row < matrix.row_count; ++row) {
        const std::uint32_t begin = matrix.row_offsets[static_cast<std::size_t>(row)];
        const std::uint32_t end = matrix.row_offsets[static_cast<std::size_t>(row + 1u)];
        if (begin > end || end > matrix.values.size()) {
            return {};
        }
        Complex value{};
        for (std::uint32_t entry = begin; entry < end; ++entry) {
            const std::uint32_t column = matrix.column_indices[entry];
            if (column >= matrix.column_count || !std::isfinite(matrix.values[entry])) {
                return {};
            }
            value += matrix.values[entry] * x[static_cast<std::size_t>(column)];
        }
        result[static_cast<std::size_t>(row)] = value;
    }
    return result;
}

std::vector<Complex> mfem_complex_matvec(
    const mfem::ComplexSparseMatrix &matrix,
    const std::vector<Complex> &x)
{
    const mfem::SparseMatrix &real = matrix.real();
    const mfem::SparseMatrix &imaginary = matrix.imag();
    if (real.Width() <= 0 || real.Height() <= 0 ||
        real.Width() != imaginary.Width() || real.Height() != imaginary.Height() ||
        static_cast<std::size_t>(real.Width()) != x.size()) {
        return {};
    }
    std::vector<Complex> result(static_cast<std::size_t>(real.Height()), Complex{});
    mfem::Array<int> columns;
    mfem::Vector values;
    for (int row = 0; row < real.Height(); ++row) {
        Complex value{};
        real.GetRow(row, columns, values);
        if (columns.Size() != values.Size()) {
            return {};
        }
        for (int entry = 0; entry < columns.Size(); ++entry) {
            if (columns[entry] < 0 || columns[entry] >= real.Width() ||
                !std::isfinite(values[entry])) {
                return {};
            }
            value += values[entry] * x[static_cast<std::size_t>(columns[entry])];
        }
        imaginary.GetRow(row, columns, values);
        if (columns.Size() != values.Size()) {
            return {};
        }
        for (int entry = 0; entry < columns.Size(); ++entry) {
            if (columns[entry] < 0 || columns[entry] >= real.Width() ||
                !std::isfinite(values[entry])) {
                return {};
            }
            value += Complex(0.0, values[entry]) *
                x[static_cast<std::size_t>(columns[entry])];
        }
        result[static_cast<std::size_t>(row)] = value;
    }
    return result;
}

std::vector<Complex> mfem_complex_adjoint_matvec(
    const mfem::ComplexSparseMatrix &matrix,
    const std::vector<Complex> &x)
{
    const mfem::SparseMatrix &real = matrix.real();
    const mfem::SparseMatrix &imaginary = matrix.imag();
    if (real.Width() <= 0 || real.Height() <= 0 ||
        real.Width() != imaginary.Width() || real.Height() != imaginary.Height() ||
        static_cast<std::size_t>(real.Height()) != x.size()) {
        return {};
    }
    std::vector<Complex> result(static_cast<std::size_t>(real.Width()), Complex{});
    mfem::Array<int> columns;
    mfem::Vector values;
    for (int row = 0; row < real.Height(); ++row) {
        real.GetRow(row, columns, values);
        if (columns.Size() != values.Size()) {
            return {};
        }
        for (int entry = 0; entry < columns.Size(); ++entry) {
            if (columns[entry] < 0 || columns[entry] >= real.Width() ||
                !std::isfinite(values[entry])) {
                return {};
            }
            result[static_cast<std::size_t>(columns[entry])] +=
                values[entry] * x[static_cast<std::size_t>(row)];
        }
        imaginary.GetRow(row, columns, values);
        if (columns.Size() != values.Size()) {
            return {};
        }
        for (int entry = 0; entry < columns.Size(); ++entry) {
            if (columns[entry] < 0 || columns[entry] >= real.Width() ||
                !std::isfinite(values[entry])) {
                return {};
            }
            result[static_cast<std::size_t>(columns[entry])] +=
                Complex(0.0, -values[entry]) * x[static_cast<std::size_t>(row)];
        }
    }
    return result;
}

double relative_residual(
    const std::vector<Complex> &residual,
    const std::vector<Complex> &term_a,
    const std::vector<Complex> &term_b,
    const std::vector<Complex> *term_c = nullptr,
    double term_c_scale = 1.0) noexcept
{
    if (residual.empty() || residual.size() != term_a.size() ||
        residual.size() != term_b.size() ||
        (term_c != nullptr && residual.size() != term_c->size())) {
        return std::numeric_limits<double>::infinity();
    }
    const double norm_a = complex_vector_norm(term_a);
    const double norm_b = complex_vector_norm(term_b);
    const double norm_c = term_c != nullptr
        ? std::abs(term_c_scale) * complex_vector_norm(*term_c)
        : 0.0;
    const double denominator = norm_a + norm_b + norm_c;
    if (!std::isfinite(denominator) || !(denominator > 0.0)) {
        return std::numeric_limits<double>::infinity();
    }
    return complex_vector_norm(residual) / denominator;
}

struct FloquetFullDescriptorDiagnostics {
    bool available = false;
    bool full_descriptor_certified = false;
    bool seam_frame_certified = false;
    bool gauge_policy_satisfied = false;
    double magnetic_relative_residual = std::numeric_limits<double>::quiet_NaN();
    double potential_relative_residual = std::numeric_limits<double>::quiet_NaN();
    double scalar_phase_seam_relative_residual =
        std::numeric_limits<double>::quiet_NaN();
    double tangent_frame_seam_relative_residual =
        std::numeric_limits<double>::quiet_NaN();
    double cartesian_magnetic_seam_relative_residual =
        std::numeric_limits<double>::quiet_NaN();
    double equilibrium_pair_relative_residual =
        std::numeric_limits<double>::quiet_NaN();
};

FloquetFullDescriptorDiagnostics certify_floquet_full_descriptor(
    const FloquetSharedDomainSparseModalOperator &operator_view,
    const std::vector<Complex> &q_reduced,
    const std::vector<Complex> &phi_reduced,
    Complex lambda,
    double tolerance)
{
    FloquetFullDescriptorDiagnostics diagnostics{};
    const PoissonAirboxSharedDomainAssemblyResult *assembly =
        operator_view.full_descriptor_assembly;
    const bool finite_k = std::all_of(
        operator_view.k_rad_per_m.begin(),
        operator_view.k_rad_per_m.end(),
        [](double value) { return std::isfinite(value); });
    const bool nonzero_k = finite_k && std::any_of(
        operator_view.k_rad_per_m.begin(),
        operator_view.k_rad_per_m.end(),
        [](double value) { return value != 0.0; });
    const bool poisson_policy_matches =
        operator_view.boundary_kind != nullptr &&
        operator_view.gauge_policy != nullptr &&
        ((std::strcmp(operator_view.boundary_kind, "pure_neumann") == 0 &&
          std::strcmp(operator_view.gauge_policy, "require_invertible") == 0) ||
         ((std::strcmp(operator_view.boundary_kind, "poisson_robin") == 0 ||
           std::strcmp(operator_view.boundary_kind, "poisson_dirichlet") == 0) &&
          std::strcmp(operator_view.gauge_policy, "none") == 0));
    if (assembly == nullptr || !assembly->floquet_sparse_operator_ready ||
        !nonzero_k || !poisson_policy_matches ||
        assembly->floquet_tangent_frames.empty() ||
        assembly->floquet_periodic_pairs.empty() ||
        assembly->floquet_full_field_blocks.scalar_operator == nullptr ||
        assembly->floquet_full_field_blocks.scalar_constraint == nullptr ||
        assembly->floquet_full_field_blocks.tangent_source == nullptr ||
        assembly->floquet_full_field_blocks.tangent_constraint == nullptr ||
        !(std::isfinite(tolerance) && tolerance > 0.0)) {
        return diagnostics;
    }

    const std::uint64_t node_count = assembly->floquet_tangent_frames.size();
    const std::uint64_t full_q_count = 2u * node_count;
    const auto &blocks = assembly->floquet_full_field_blocks;
    const mfem::SparseMatrix &p_real = blocks.scalar_operator->real();
    const mfem::SparseMatrix &p_imag = blocks.scalar_operator->imag();
    const mfem::SparseMatrix &phi_c_real = blocks.scalar_constraint->real();
    const mfem::SparseMatrix &phi_c_imag = blocks.scalar_constraint->imag();
    const mfem::SparseMatrix &q_c_real = blocks.tangent_constraint->real();
    const mfem::SparseMatrix &q_c_imag = blocks.tangent_constraint->imag();
    const mfem::SparseMatrix &source_real = blocks.tangent_source->real();
    const mfem::SparseMatrix &source_imag = blocks.tangent_source->imag();
    if (assembly->floquet_full_a_qq.row_count != full_q_count ||
        assembly->floquet_full_a_qq.column_count != full_q_count ||
        assembly->floquet_full_b_qq.row_count != full_q_count ||
        assembly->floquet_full_b_qq.column_count != full_q_count ||
        p_real.Height() != p_imag.Height() || p_real.Width() != p_imag.Width() ||
        p_real.Height() != static_cast<int>(node_count) ||
        p_real.Width() != static_cast<int>(node_count) ||
        phi_c_real.Height() != phi_c_imag.Height() ||
        phi_c_real.Width() != phi_c_imag.Width() ||
        phi_c_real.Height() != static_cast<int>(node_count) ||
        phi_c_real.Width() != static_cast<int>(phi_reduced.size()) ||
        q_c_real.Height() != q_c_imag.Height() || q_c_real.Width() != q_c_imag.Width() ||
        q_c_real.Height() != static_cast<int>(full_q_count) ||
        q_c_real.Width() != static_cast<int>(q_reduced.size()) ||
        source_real.Height() != source_imag.Height() ||
        source_real.Width() != source_imag.Width() ||
        source_real.Height() != static_cast<int>(node_count) ||
        source_real.Width() != static_cast<int>(full_q_count) ||
        q_reduced.size() != operator_view.q_complex_dof_count ||
        phi_reduced.size() != operator_view.phi_dof_count ||
        assembly->floquet_periodic_pairs.empty()) {
        return diagnostics;
    }
    for (const FloquetDescriptorPeriodicPair &pair : assembly->floquet_periodic_pairs) {
        if (pair.node_a >= node_count || pair.node_b >= node_count ||
            pair.node_a == pair.node_b) {
            return diagnostics;
        }
    }
    diagnostics.available = true;
    diagnostics.gauge_policy_satisfied = true;

    const std::vector<Complex> q_full = mfem_complex_matvec(
        *blocks.tangent_constraint,
        q_reduced);
    const std::vector<Complex> phi_full = mfem_complex_matvec(
        *blocks.scalar_constraint,
        phi_reduced);
    const std::vector<Complex> a_qq_q = real_csr_matvec(
        assembly->floquet_full_a_qq,
        q_full);
    const std::vector<Complex> b_q = real_csr_matvec(
        assembly->floquet_full_b_qq,
        q_full);
    const std::vector<Complex> p_phi = mfem_complex_matvec(
        *blocks.scalar_operator,
        phi_full);
    const std::vector<Complex> source_q = mfem_complex_matvec(
        *blocks.tangent_source,
        q_full);
    const std::vector<Complex> source_adjoint_phi = mfem_complex_adjoint_matvec(
        *blocks.tangent_source,
        phi_full);
    if (q_full.size() != full_q_count || phi_full.size() != node_count ||
        a_qq_q.size() != full_q_count || b_q.size() != full_q_count ||
        p_phi.size() != node_count || source_q.size() != node_count ||
        source_adjoint_phi.size() != full_q_count) {
        diagnostics.magnetic_relative_residual = std::numeric_limits<double>::infinity();
        diagnostics.potential_relative_residual = std::numeric_limits<double>::infinity();
        return diagnostics;
    }

    std::vector<Complex> magnetic_feedback(source_adjoint_phi.size(), Complex{});
    for (std::size_t index = 0u; index < magnetic_feedback.size(); ++index) {
        magnetic_feedback[index] = operator_view.mu0_T_m_A * source_adjoint_phi[index];
    }
    std::vector<Complex> magnetic_residual_full(full_q_count, Complex{});
    for (std::size_t index = 0u; index < magnetic_residual_full.size(); ++index) {
        magnetic_residual_full[index] =
            a_qq_q[index] + magnetic_feedback[index] - lambda * b_q[index];
    }
    std::vector<Complex> potential_residual_full(node_count, Complex{});
    for (std::size_t index = 0u; index < potential_residual_full.size(); ++index) {
        potential_residual_full[index] = p_phi[index] - source_q[index];
    }

    const std::vector<Complex> projected_magnetic_residual = mfem_complex_adjoint_matvec(
        *blocks.tangent_constraint,
        magnetic_residual_full);
    const std::vector<Complex> projected_a_qq = mfem_complex_adjoint_matvec(
        *blocks.tangent_constraint,
        a_qq_q);
    const std::vector<Complex> projected_feedback = mfem_complex_adjoint_matvec(
        *blocks.tangent_constraint,
        magnetic_feedback);
    const std::vector<Complex> projected_b = mfem_complex_adjoint_matvec(
        *blocks.tangent_constraint,
        b_q);
    const std::vector<Complex> projected_potential_residual = mfem_complex_adjoint_matvec(
        *blocks.scalar_constraint,
        potential_residual_full);
    const std::vector<Complex> projected_p_phi = mfem_complex_adjoint_matvec(
        *blocks.scalar_constraint,
        p_phi);
    const std::vector<Complex> projected_source = mfem_complex_adjoint_matvec(
        *blocks.scalar_constraint,
        source_q);
    std::vector<Complex> projected_lambda_b(projected_b.size(), Complex{});
    for (std::size_t index = 0u; index < projected_lambda_b.size(); ++index) {
        projected_lambda_b[index] = lambda * projected_b[index];
    }
    diagnostics.magnetic_relative_residual = relative_residual(
        projected_magnetic_residual,
        projected_a_qq,
        projected_feedback,
        &projected_lambda_b);
    diagnostics.potential_relative_residual = relative_residual(
        projected_potential_residual,
        projected_p_phi,
        projected_source);

    long double scalar_difference_squared = 0.0L;
    long double scalar_scale_squared = 0.0L;
    long double tangent_difference_squared = 0.0L;
    long double tangent_scale_squared = 0.0L;
    long double cartesian_difference_squared = 0.0L;
    long double cartesian_scale_squared = 0.0L;
    double equilibrium_pair_residual = 0.0;
    std::size_t active_magnetic_pair_count = 0u;
    constexpr double min_scale = std::numeric_limits<double>::min();
    const auto phase_for_pair = [&assembly](const FloquetDescriptorPeriodicPair &pair) {
        const double argument =
            assembly->floquet_k_rad_per_m[0] * pair.translation_m[0] +
            assembly->floquet_k_rad_per_m[1] * pair.translation_m[1] +
            assembly->floquet_k_rad_per_m[2] * pair.translation_m[2];
        return std::polar(1.0, -argument);
    };
    for (const FloquetDescriptorPeriodicPair &pair : assembly->floquet_periodic_pairs) {
        const Complex phase = phase_for_pair(pair);
        const Complex phi_a = phi_full[static_cast<std::size_t>(pair.node_a)];
        const Complex phi_b = phi_full[static_cast<std::size_t>(pair.node_b)];
        const Complex phi_expected = phase * phi_a;
        scalar_difference_squared += static_cast<long double>(std::norm(phi_b - phi_expected));
        scalar_scale_squared += static_cast<long double>(std::norm(phi_b) + std::norm(phi_expected));
        if (!pair.magnetic_active) {
            continue;
        }
        ++active_magnetic_pair_count;
        const TangentFrameNode &frame_a =
            assembly->floquet_tangent_frames[static_cast<std::size_t>(pair.node_a)];
        const TangentFrameNode &frame_b =
            assembly->floquet_tangent_frames[static_cast<std::size_t>(pair.node_b)];
        const Complex qa[2] = {
            q_full[static_cast<std::size_t>(2u * pair.node_a)],
            q_full[static_cast<std::size_t>(2u * pair.node_a + 1u)]};
        const Complex qb[2] = {
            q_full[static_cast<std::size_t>(2u * pair.node_b)],
            q_full[static_cast<std::size_t>(2u * pair.node_b + 1u)]};
        double equilibrium_difference_squared = 0.0;
        double equilibrium_scale_squared = 0.0;
        for (int axis = 0; axis < 3; ++axis) {
            const double difference = frame_b.m[axis] - frame_a.m[axis];
            equilibrium_difference_squared += difference * difference;
            equilibrium_scale_squared +=
                frame_a.m[axis] * frame_a.m[axis] + frame_b.m[axis] * frame_b.m[axis];
        }
        const double pair_equilibrium_residual =
            std::sqrt(equilibrium_difference_squared) /
            std::max(std::sqrt(equilibrium_scale_squared), min_scale);
        equilibrium_pair_residual = std::max(
            equilibrium_pair_residual,
            pair_equilibrium_residual);
        Complex cartesian_a[3] = {Complex{}, Complex{}, Complex{}};
        Complex cartesian_b[3] = {Complex{}, Complex{}, Complex{}};
        for (int axis = 0; axis < 3; ++axis) {
            cartesian_a[axis] = frame_a.e1[axis] * qa[0] + frame_a.e2[axis] * qa[1];
            cartesian_b[axis] = frame_b.e1[axis] * qb[0] + frame_b.e2[axis] * qb[1];
        }
        for (int row = 0; row < 2; ++row) {
            Complex expected = Complex{};
            const double *basis_b = row == 0 ? frame_b.e1 : frame_b.e2;
            for (int column = 0; column < 2; ++column) {
                const double *basis_a = column == 0 ? frame_a.e1 : frame_a.e2;
                const double rotation =
                    basis_b[0] * basis_a[0] + basis_b[1] * basis_a[1] +
                    basis_b[2] * basis_a[2];
                expected += phase * rotation * qa[column];
            }
            tangent_difference_squared += static_cast<long double>(std::norm(qb[row] - expected));
            tangent_scale_squared +=
                static_cast<long double>(std::norm(qb[row]) + std::norm(expected));
        }
        for (int axis = 0; axis < 3; ++axis) {
            const Complex expected = phase * cartesian_a[axis];
            cartesian_difference_squared +=
                static_cast<long double>(std::norm(cartesian_b[axis] - expected));
            cartesian_scale_squared += static_cast<long double>(
                std::norm(cartesian_b[axis]) + std::norm(expected));
        }
    }
    const auto normalized_pair_residual = [](long double difference, long double scale) {
        if (!std::isfinite(static_cast<double>(difference)) ||
            !std::isfinite(static_cast<double>(scale))) {
            return std::numeric_limits<double>::infinity();
        }
        if (!(scale > 0.0L)) {
            return difference == 0.0L
                ? 0.0
                : std::numeric_limits<double>::infinity();
        }
        return std::sqrt(static_cast<double>(difference / scale));
    };
    diagnostics.scalar_phase_seam_relative_residual = normalized_pair_residual(
        scalar_difference_squared,
        scalar_scale_squared);
    diagnostics.tangent_frame_seam_relative_residual = normalized_pair_residual(
        tangent_difference_squared,
        tangent_scale_squared);
    diagnostics.cartesian_magnetic_seam_relative_residual = normalized_pair_residual(
        cartesian_difference_squared,
        cartesian_scale_squared);
    diagnostics.equilibrium_pair_relative_residual = equilibrium_pair_residual;
    const auto below_tolerance = [tolerance](double value) {
        return std::isfinite(value) && value >= 0.0 && value <= tolerance;
    };
    diagnostics.seam_frame_certified =
        active_magnetic_pair_count > 0u &&
        below_tolerance(diagnostics.scalar_phase_seam_relative_residual) &&
        below_tolerance(diagnostics.tangent_frame_seam_relative_residual) &&
        below_tolerance(diagnostics.cartesian_magnetic_seam_relative_residual) &&
        below_tolerance(diagnostics.equilibrium_pair_relative_residual);
    diagnostics.full_descriptor_certified =
        diagnostics.gauge_policy_satisfied &&
        below_tolerance(diagnostics.magnetic_relative_residual) &&
        below_tolerance(diagnostics.potential_relative_residual) &&
        diagnostics.seam_frame_certified;
    return diagnostics;
}

#endif // FULLMAG_HAS_MFEM_STACK

#if FULLMAG_FEM_WITH_SLEPC

// PETSc compares the explicitly rebuilt residual at a restart against the
// residual at the beginning of the preceding cycle.  The real-split Schur
// action can reach roundoff with a bounded transient increase in that rebuilt
// residual.  The signed-path pilots observed discrepancy ratios of 1.045 and
// 1.362 relative to the complete cycle-start residual.  Permit at most twice
// that residual, then restart from the explicitly rebuilt vector.  This does
// not relax convergence: KSP remains error-if-not-converged and independent
// shifted-system and original-descriptor residuals remain mandatory below.
constexpr PetscInt kFloquetShiftedGmresDefaultRestart = 8;
// Materializing the exact Schur action is bounded to the small validation
// systems for which it is inexpensive.  It gives shift-invert an LU
// preconditioner containing the dynamic-demag feedback that the sparse
// magnetic-only approximation omits.  Larger production systems retain the
// sparse approximation until a scalable block preconditioner is available.
constexpr PetscInt kFloquetExactSchurPreconditionerMaxDimension = 512;

#if defined(PETSC_USE_COMPLEX)
// The modal production contract uses a real PETSc build and performs the
// complex Floquet algebra in a real split.  A complex PETSc build would make
// the pair-vector interpretation ambiguous, so fail explicitly.
#endif

// Retain one bounded diagnostic sample; estimates are not accepted modes.
PetscErrorCode monitor_native_floquet_eps(
    EPS, PetscInt iteration, PetscInt converged,
    PetscScalar[], PetscScalar[], PetscReal estimates[], PetscInt count,
    void *raw_result)
{
    if (raw_result == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    auto *result = static_cast<SLEPcTinyGyrotropicModalEigenResult *>(raw_result);
    result->eps_monitor_iteration = static_cast<int>(iteration);
    result->eps_first_unconverged_error_estimate =
        estimates != nullptr && converged >= 0 && converged < count
            ? static_cast<double>(estimates[converged])
            : std::numeric_limits<double>::quiet_NaN();
    return 0;
}

struct NativeFloquetMatShellContext {
    Mat a_qq = nullptr;
    Mat rotated_a_qq = nullptr;
    Mat a_qphi = nullptr;
    Mat a_phiq = nullptr;
    Mat p = nullptr;
    KSP p_ksp = nullptr;
    Vec phi_rhs = nullptr;
    Vec phi_solution = nullptr;
    Vec feedback = nullptr;
    Vec q_physical_real = nullptr;
    Vec q_physical_imag = nullptr;
    PetscInt q_split_count = 0;
    PetscInt q_complex_count = 0;
    PetscInt phi_split_count = 0;
    int phase_sign = 1;
    char error_message[256]{};
};

struct LastFloquetShiftedSolveSnapshot {
    Mat shifted_operator = nullptr; // Owns one PETSc reference.
    Vec rhs = nullptr;
    Vec solution = nullptr;
    Vec true_residual = nullptr;
    bool available = false;
    bool monitor_registered = false;
    std::uint64_t monitor_observation_count = 0;
    bool monitor_last_iteration_available = false;
    std::int64_t monitor_last_iteration = 0;
    bool monitor_recursive_residual_available = false;
    double monitor_recursive_residual_norm =
        std::numeric_limits<double>::quiet_NaN();
    bool monitor_last_reason_available = false;
    int monitor_last_observed_reason = 0;
    int true_residual_sample_count = 0;
    int true_residual_measurement_failure_count = 0;
    double maximum_true_relative_residual = 0.0;
    std::uint64_t criterion_solve_count = 0;
    std::uint64_t criterion_measured_count = 0;
    std::uint64_t criterion_violation_count = 0;
    std::uint64_t criterion_unavailable_count = 0;
    double criterion_maximum_tolerance_ratio = 0.0;
    PetscReal expected_rtol = 0.0;
    PetscReal expected_atol = 0.0;
};

PetscErrorCode capture_last_floquet_shifted_solve(
    KSP ksp, Vec rhs, Vec solution, void *raw_snapshot)
{
    auto *snapshot = static_cast<LastFloquetShiftedSolveSnapshot *>(raw_snapshot);
    if (snapshot == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    ++snapshot->criterion_solve_count;
    snapshot->available = false;
    Mat shifted_operator = nullptr;
    if (rhs == nullptr || solution == nullptr ||
        KSPGetOperators(ksp, &shifted_operator, nullptr) != 0 ||
        shifted_operator == nullptr ||
        (snapshot->rhs == nullptr && VecDuplicate(rhs, &snapshot->rhs) != 0) ||
        (snapshot->solution == nullptr &&
         VecDuplicate(solution, &snapshot->solution) != 0) ||
        VecCopy(rhs, snapshot->rhs) != 0 ||
        VecCopy(solution, snapshot->solution) != 0) {
        ++snapshot->true_residual_measurement_failure_count;
        ++snapshot->criterion_unavailable_count;
        return 0; // A diagnostic failure must not alter the eigensolve.
    }
    if (snapshot->shifted_operator != shifted_operator) {
        if (PetscObjectReference(
                reinterpret_cast<PetscObject>(shifted_operator)) != 0) {
            ++snapshot->true_residual_measurement_failure_count;
            ++snapshot->criterion_unavailable_count;
            return 0;
        }
        Mat previous = snapshot->shifted_operator;
        snapshot->shifted_operator = shifted_operator;
        if (previous != nullptr) {
            MatDestroy(&previous);
        }
    }
    snapshot->available = true;
    PetscReal rhs_norm = 0.0;
    PetscReal residual_norm = 0.0;
    const bool measured =
        (snapshot->true_residual != nullptr ||
         VecDuplicate(rhs, &snapshot->true_residual) == 0) &&
        MatMult(shifted_operator, solution, snapshot->true_residual) == 0 &&
        VecAYPX(snapshot->true_residual, -1.0, rhs) == 0 &&
        VecNorm(rhs, NORM_2, &rhs_norm) == 0 &&
        VecNorm(snapshot->true_residual, NORM_2, &residual_norm) == 0 &&
        std::isfinite(static_cast<double>(rhs_norm)) &&
        std::isfinite(static_cast<double>(residual_norm));
    if (measured) {
        const double relative_residual =
            static_cast<double>(residual_norm) /
            std::max(static_cast<double>(rhs_norm),
                     std::numeric_limits<double>::min());
        snapshot->maximum_true_relative_residual = std::max(
            snapshot->maximum_true_relative_residual, relative_residual);
        ++snapshot->true_residual_sample_count;
    } else {
        ++snapshot->true_residual_measurement_failure_count;
    }
    // Observe the true criterion for EACH solve, not just the last RHS.
    // This is diagnostic-only: it does not change KSP convergence or EPS.
    PetscBool initial_guess_nonzero = PETSC_TRUE;
    PetscReal actual_rtol = 0.0;
    PetscReal actual_atol = 0.0;
    PCSide actual_side = PC_SIDE_DEFAULT;
    KSPNormType actual_norm = KSP_NORM_DEFAULT;
    KSPConvergedReason reason = KSP_CONVERGED_ITERATING;
    const bool criterion_available = measured &&
        KSPGetInitialGuessNonzero(ksp, &initial_guess_nonzero) == 0 &&
        initial_guess_nonzero == PETSC_FALSE &&
        KSPGetTolerances(ksp, &actual_rtol, &actual_atol, nullptr, nullptr) == 0 &&
        std::isfinite(static_cast<double>(actual_rtol)) && actual_rtol > 0.0 &&
        std::isfinite(static_cast<double>(actual_atol)) && actual_atol >= 0.0 &&
        actual_rtol == snapshot->expected_rtol &&
        actual_atol == snapshot->expected_atol &&
        KSPGetPCSide(ksp, &actual_side) == 0 && actual_side == PC_RIGHT &&
        KSPGetNormType(ksp, &actual_norm) == 0 &&
        actual_norm == KSP_NORM_UNPRECONDITIONED &&
        KSPGetConvergedReason(ksp, &reason) == 0;
    const double relative_threshold =
        static_cast<double>(actual_rtol) * static_cast<double>(rhs_norm);
    const double threshold = std::max(static_cast<double>(actual_atol),
                                      relative_threshold);
    if (!criterion_available || !std::isfinite(relative_threshold) ||
        !std::isfinite(threshold)) {
        ++snapshot->criterion_unavailable_count;
        return 0;
    }
    ++snapshot->criterion_measured_count;
    if (reason <= 0 || static_cast<double>(residual_norm) > threshold) {
        ++snapshot->criterion_violation_count;
    }
    // A zero RHS/zero threshold requires an EXACT zero absolute residual.
    const double ratio = threshold > 0.0
        ? static_cast<double>(residual_norm) / threshold
        : (residual_norm == 0.0 ? 0.0
                               : std::numeric_limits<double>::infinity());
    snapshot->criterion_maximum_tolerance_ratio = std::max(
        snapshot->criterion_maximum_tolerance_ratio, ratio);
    return 0;
}

PetscErrorCode capture_floquet_shifted_ksp_progress(
    KSP ksp, PetscInt iteration, PetscReal recursive_residual_norm,
    void *raw_snapshot)
{
    auto *snapshot = static_cast<LastFloquetShiftedSolveSnapshot *>(raw_snapshot);
    if (snapshot == nullptr) {
        return 0; // A diagnostic callback must never alter KSP behavior.
    }

    ++snapshot->monitor_observation_count;
    snapshot->monitor_last_iteration_available = iteration >= 0;
    snapshot->monitor_last_iteration = snapshot->monitor_last_iteration_available
        ? static_cast<std::int64_t>(iteration)
        : 0;
    snapshot->monitor_recursive_residual_available =
        std::isfinite(static_cast<double>(recursive_residual_norm)) &&
        recursive_residual_norm >= 0.0;
    snapshot->monitor_recursive_residual_norm =
        snapshot->monitor_recursive_residual_available
            ? static_cast<double>(recursive_residual_norm)
            : std::numeric_limits<double>::quiet_NaN();

    KSPConvergedReason reason = KSP_CONVERGED_ITERATING;
    snapshot->monitor_last_reason_available =
        ksp != nullptr && KSPGetConvergedReason(ksp, &reason) == 0;
    snapshot->monitor_last_observed_reason =
        snapshot->monitor_last_reason_available
            ? static_cast<int>(reason)
            : 0;
    return 0;
}

std::mutex &native_floquet_solver_mutex()
{
    static std::mutex mutex;
    return mutex;
}

void copy_native_floquet_error(
    NativeFloquetMatShellContext *context,
    const char *message) noexcept
{
    if (context == nullptr) {
        return;
    }
    std::strncpy(
        context->error_message,
        message != nullptr ? message : "",
        sizeof(context->error_message) - 1u);
    context->error_message[sizeof(context->error_message) - 1u] = '\0';
}

bool create_real_split_matrix(
    const PoissonAirboxSharedDomainComplexCsrMatrix &source,
    Mat *out_matrix,
    int rotation_sign = 0)
{
    if (out_matrix == nullptr || source.row_count == 0u || source.column_count == 0u ||
        (rotation_sign != -1 && rotation_sign != 0 && rotation_sign != 1) ||
        source.row_count > static_cast<std::uint64_t>(
            std::numeric_limits<PetscInt>::max() / 2) ||
        source.column_count > static_cast<std::uint64_t>(
            std::numeric_limits<PetscInt>::max() / 2) ||
        source.row_offsets.size() != static_cast<std::size_t>(source.row_count + 1u)) {
        return false;
    }
    const PetscInt rows = static_cast<PetscInt>(2u * source.row_count);
    const PetscInt columns = static_cast<PetscInt>(2u * source.column_count);
    std::vector<PetscInt> row_nonzeros(static_cast<std::size_t>(rows), 0);
    for (std::uint64_t row = 0u; row < source.row_count; ++row) {
        const std::uint64_t nnz =
            source.row_offsets[static_cast<std::size_t>(row + 1u)] -
            source.row_offsets[static_cast<std::size_t>(row)];
        if (nnz > static_cast<std::uint64_t>(
                std::numeric_limits<PetscInt>::max() / 2)) {
            return false;
        }
        row_nonzeros[static_cast<std::size_t>(row)] = static_cast<PetscInt>(2u * nnz);
        row_nonzeros[static_cast<std::size_t>(source.row_count + row)] =
            static_cast<PetscInt>(2u * nnz);
    }
    if (MatCreateSeqAIJ(
            PETSC_COMM_SELF,
            rows,
            columns,
            0,
            row_nonzeros.data(),
            out_matrix) != 0) {
        return false;
    }
    if (MatSetOption(*out_matrix, MAT_NEW_NONZERO_ALLOCATION_ERR, PETSC_FALSE) != 0) {
        MatDestroy(out_matrix);
        return false;
    }
    const PetscInt column_base = static_cast<PetscInt>(source.column_count);
    const PetscInt row_base = static_cast<PetscInt>(source.row_count);
    for (std::uint64_t row = 0u; row < source.row_count; ++row) {
        for (std::uint32_t entry = source.row_offsets[static_cast<std::size_t>(row)];
             entry < source.row_offsets[static_cast<std::size_t>(row + 1u)];
             ++entry) {
            const auto value = source.values[entry];
            const double block_real = rotation_sign == 0
                ? value.real()
                : static_cast<double>(rotation_sign) * value.imag();
            const double block_imag = rotation_sign == 0
                ? value.imag()
                : -static_cast<double>(rotation_sign) * value.real();
            const PetscInt petsc_row = static_cast<PetscInt>(row);
            const PetscInt petsc_column =
                static_cast<PetscInt>(source.column_indices[entry]);
            if (!std::isfinite(value.real()) || !std::isfinite(value.imag())) {
                MatDestroy(out_matrix);
                return false;
            }
            if (block_real != 0.0 &&
                (MatSetValue(
                     *out_matrix,
                     petsc_row,
                     petsc_column,
                     static_cast<PetscScalar>(block_real),
                     ADD_VALUES) != 0 ||
                 MatSetValue(
                     *out_matrix,
                     petsc_row + row_base,
                     petsc_column + column_base,
                     static_cast<PetscScalar>(block_real),
                     ADD_VALUES) != 0)) {
                MatDestroy(out_matrix);
                return false;
            }
            if (block_imag != 0.0 &&
                (MatSetValue(
                     *out_matrix,
                     petsc_row,
                     petsc_column + column_base,
                     static_cast<PetscScalar>(-block_imag),
                     ADD_VALUES) != 0 ||
                 MatSetValue(
                     *out_matrix,
                     petsc_row + row_base,
                     petsc_column,
                     static_cast<PetscScalar>(block_imag),
                     ADD_VALUES) != 0)) {
                MatDestroy(out_matrix);
                return false;
            }
        }
    }
    if (MatAssemblyBegin(*out_matrix, MAT_FINAL_ASSEMBLY) != 0 ||
        MatAssemblyEnd(*out_matrix, MAT_FINAL_ASSEMBLY) != 0) {
        MatDestroy(out_matrix);
        return false;
    }
    return true;
}

// Build the shifted right preconditioner without replacing the matrix-free
// eigensolver operator. Small validation systems materialize the exact Schur
// action; larger systems retain the sparse magnetic-only approximation.
bool create_native_floquet_shifted_preconditioner(
    Mat schur_shell,
    Mat rotated_a_qq,
    Mat gyrotropic,
    PetscScalar shift,
    Mat *out_matrix,
    double *normalization_scale,
    bool *exact_schur_materialized)
{
    if (schur_shell == nullptr || rotated_a_qq == nullptr || gyrotropic == nullptr ||
        out_matrix == nullptr || normalization_scale == nullptr ||
        exact_schur_materialized == nullptr) {
        return false;
    }
    *out_matrix = nullptr;
    *normalization_scale = 1.0;
    *exact_schur_materialized = false;
    PetscInt row_count = 0;
    PetscInt column_count = 0;
    if (MatGetSize(schur_shell, &row_count, &column_count) != 0 ||
        row_count <= 0 || row_count != column_count) {
        return false;
    }
    if (row_count <= kFloquetExactSchurPreconditionerMaxDimension) {
        if (MatComputeOperator(schur_shell, MATAIJ, out_matrix) != 0) {
            return false;
        }
        *exact_schur_materialized = true;
    } else if (MatDuplicate(rotated_a_qq, MAT_COPY_VALUES, out_matrix) != 0) {
        return false;
    }
    if (
        MatAXPY(
            *out_matrix,
            static_cast<PetscScalar>(-shift),
            gyrotropic,
            DIFFERENT_NONZERO_PATTERN) != 0 ||
        // The real-frequency rotation can leave a zero diagonal in the
        // magnetic block.  PETSc's sparse LU requires every row to have a
        // diagonal slot, even when its value is zero.  Insert zero-valued
        // structural entries without changing the preconditioner values.
        MatSetOption(*out_matrix, MAT_NEW_NONZERO_ALLOCATION_ERR, PETSC_FALSE) != 0 ||
        MatSetOption(*out_matrix, MAT_IGNORE_ZERO_ENTRIES, PETSC_FALSE) != 0) {
        if (*out_matrix != nullptr) {
            MatDestroy(out_matrix);
        }
        return false;
    }
    PetscInt row_begin = 0;
    PetscInt row_end = 0;
    if (MatGetOwnershipRange(*out_matrix, &row_begin, &row_end) != 0) {
        MatDestroy(out_matrix);
        return false;
    }
    for (PetscInt row = row_begin; row < row_end; ++row) {
        if (MatSetValue(*out_matrix, row, row, static_cast<PetscScalar>(0.0), ADD_VALUES) != 0) {
            MatDestroy(out_matrix);
            return false;
        }
    }
    if (MatAssemblyBegin(*out_matrix, MAT_FINAL_ASSEMBLY) != 0 ||
        MatAssemblyEnd(*out_matrix, MAT_FINAL_ASSEMBLY) != 0) {
        if (*out_matrix != nullptr) {
            MatDestroy(out_matrix);
        }
        return false;
    }
    PetscReal matrix_norm = 0.0;
    if (MatNorm(*out_matrix, NORM_INFINITY, &matrix_norm) != 0 ||
        !std::isfinite(static_cast<double>(matrix_norm)) || matrix_norm <= 0.0) {
        MatDestroy(out_matrix);
        return false;
    }
    const double scale = 1.0 / static_cast<double>(matrix_norm);
    if (!std::isfinite(scale) || MatScale(*out_matrix, static_cast<PetscScalar>(scale)) != 0) {
        MatDestroy(out_matrix);
        return false;
    }
    // Scaling a right preconditioner by a nonzero scalar leaves the shifted
    // eigensolver operator and its eigenfrequencies unchanged.  It prevents
    // PETSc's absolute LU zero-pivot threshold from rejecting SI-sized FEM
    // coefficients before GMRES can apply the actual Schur complement.
    *normalization_scale = scale;
    return true;
}

bool normalize_native_floquet_pencil(
    NativeFloquetMatShellContext *context,
    Mat gyrotropic,
    PetscReal target_shift,
    double previous_normalization_scale,
    double *normalization_scale)
{
    if (context == nullptr || gyrotropic == nullptr || normalization_scale == nullptr ||
        !std::isfinite(static_cast<double>(target_shift)) ||
        !std::isfinite(previous_normalization_scale) ||
        previous_normalization_scale <= 0.0) {
        return false;
    }
    PetscReal magnetic_norm = 0.0;
    PetscReal gyrotropic_norm = 0.0;
    if (MatNorm(context->a_qq, NORM_INFINITY, &magnetic_norm) != 0 ||
        MatNorm(gyrotropic, NORM_INFINITY, &gyrotropic_norm) != 0) {
        return false;
    }
    const double scale_reference = std::max({
        static_cast<double>(magnetic_norm),
        static_cast<double>(gyrotropic_norm),
        std::abs(static_cast<double>(target_shift)) *
            static_cast<double>(gyrotropic_norm)});
    if (!std::isfinite(scale_reference) || scale_reference <= 0.0) {
        return false;
    }
    // MatNorm observes the matrices after the previous target's scaling.  If
    // their current absolute scale is p, the desired absolute scale is
    // p/reference_scaled; therefore the multiplicative update is simply
    // 1/reference_scaled.  Keeping these two values separate prevents a
    // second target from applying the absolute scale twice.
    const double scale_ratio = 1.0 / scale_reference;
    const double scale = previous_normalization_scale * scale_ratio;
    if (!std::isfinite(scale_ratio) || scale_ratio <= 0.0) {
        return false;
    }
    if (!std::isfinite(scale) ||
        MatScale(context->a_qq, static_cast<PetscScalar>(scale_ratio)) != 0 ||
        MatScale(context->rotated_a_qq, static_cast<PetscScalar>(scale_ratio)) != 0 ||
        MatScale(context->a_qphi, static_cast<PetscScalar>(scale_ratio)) != 0 ||
        MatScale(gyrotropic, static_cast<PetscScalar>(scale_ratio)) != 0) {
        return false;
    }
    // The Schur action is A_qq - A_qphi P^-1 A_phiq. Scaling A_qq and
    // A_qphi together with B_qq multiplies both sides of its generalized
    // eigenproblem by the same factor. P and A_phiq remain in physical units
    // for potential reconstruction and original-pencil residual checks.
    *normalization_scale = scale;
    return true;
}

PetscErrorCode apply_native_floquet_schur_components(
    NativeFloquetMatShellContext *context,
    Vec x,
    Vec magnetic_output,
    Vec feedback_output,
    Vec phi_rhs,
    Vec phi_solution,
    Vec potential_rhs)
{
    if (context == nullptr || x == nullptr || magnetic_output == nullptr ||
        feedback_output == nullptr || phi_rhs == nullptr || phi_solution == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    PetscInt size = 0;
    if (VecGetSize(x, &size) != 0 || size != context->q_split_count ||
        VecGetSize(magnetic_output, &size) != 0 || size != context->q_split_count ||
        VecGetSize(feedback_output, &size) != 0 || size != context->q_split_count ||
        VecGetSize(phi_rhs, &size) != 0 || size != context->phi_split_count ||
        VecGetSize(phi_solution, &size) != 0 || size != context->phi_split_count ||
        (potential_rhs != nullptr &&
         (VecGetSize(potential_rhs, &size) != 0 || size != context->phi_split_count))) {
        return PETSC_ERR_ARG_SIZ;
    }
    Vec positive_potential_rhs = potential_rhs != nullptr ? potential_rhs : phi_rhs;
    if (MatMult(context->a_phiq, x, positive_potential_rhs) != 0 ||
        (potential_rhs != nullptr && VecCopy(positive_potential_rhs, phi_rhs) != 0) ||
        VecScale(phi_rhs, static_cast<PetscScalar>(-1.0)) != 0 ||
        KSPSolve(context->p_ksp, phi_rhs, phi_solution) != 0) {
        return PETSC_ERR_NOT_CONVERGED;
    }
    KSPConvergedReason reason = KSP_CONVERGED_ITERATING;
    if (KSPGetConvergedReason(context->p_ksp, &reason) != 0 || reason < 0) {
        return PETSC_ERR_NOT_CONVERGED;
    }
    if (MatMult(context->a_qq, x, magnetic_output) != 0 ||
        MatMult(context->a_qphi, phi_solution, feedback_output) != 0) {
        return PETSC_ERR_LIB;
    }
    return 0;
}

PetscErrorCode rotate_native_floquet_vector_in_place(
    const NativeFloquetMatShellContext *context,
    Vec values)
{
    if (context == nullptr || values == nullptr || context->q_complex_count <= 0 ||
        context->q_split_count != 2 * context->q_complex_count) {
        return PETSC_ERR_ARG_SIZ;
    }
    PetscInt size = 0;
    if (VecGetSize(values, &size) != 0 || size != context->q_split_count) {
        return PETSC_ERR_ARG_SIZ;
    }
    PetscScalar *raw_values = nullptr;
    if (VecGetArray(values, &raw_values) != 0 || raw_values == nullptr) {
        return PETSC_ERR_LIB;
    }
    for (PetscInt index = 0; index < context->q_complex_count; ++index) {
        const PetscScalar real_part = raw_values[index];
        const PetscScalar imaginary_part =
            raw_values[context->q_complex_count + index];
        raw_values[index] = static_cast<PetscScalar>(context->phase_sign) *
            imaginary_part;
        raw_values[context->q_complex_count + index] =
            -static_cast<PetscScalar>(context->phase_sign) * real_part;
    }
    return VecRestoreArray(values, &raw_values);
}

PetscErrorCode native_floquet_matmult(Mat matrix, Vec x, Vec y)
{
    void *raw_context = nullptr;
    if (MatShellGetContext(matrix, &raw_context) != 0 || raw_context == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    auto *context = static_cast<NativeFloquetMatShellContext *>(raw_context);
    PetscInt size = 0;
    if (VecGetSize(x, &size) != 0 || size != context->q_split_count) {
        copy_native_floquet_error(context, "Floquet MatShell q dimensions do not match");
        return PETSC_ERR_ARG_SIZ;
    }
    const PetscErrorCode component_error = apply_native_floquet_schur_components(
        context,
        x,
        y,
        context->feedback,
        context->phi_rhs,
        context->phi_solution,
        nullptr);
    if (component_error == PETSC_ERR_NOT_CONVERGED) {
        copy_native_floquet_error(context, "Floquet MatShell scalar Schur solve failed");
        return component_error;
    }
    if (component_error != 0 ||
        VecAXPY(y, static_cast<PetscScalar>(1.0), context->feedback) != 0 ||
        VecCopy(y, context->feedback) != 0) {
        copy_native_floquet_error(context, "Floquet MatShell magnetic Schur action failed");
        return PETSC_ERR_LIB;
    }
    if (rotate_native_floquet_vector_in_place(context, y) != 0) {
        copy_native_floquet_error(context, "Floquet MatShell rotation workspace failed");
        return PETSC_ERR_LIB;
    }
    return 0;
}

bool run_floquet_schur_action_diagnostic(
    NativeFloquetMatShellContext *context,
    double operator_normalization_scale,
    double preconditioner_normalization_scale,
    FloquetSchurActionDiagnostic *out)
{
    if (out == nullptr) {
        return false;
    }
    *out = FloquetSchurActionDiagnostic{};
    out->requested = floquet_schur_action_diagnostic_requested();
    if (!out->requested) {
        return true;
    }
    out->status = "unavailable";
    out->reason = "diagnostic_not_started";
    out->operator_normalization_scale = operator_normalization_scale;
    out->preconditioner_normalization_scale = preconditioner_normalization_scale;
    if (context == nullptr || context->q_complex_count <= 0 ||
        context->q_split_count <= 0 || context->phi_split_count <= 0 ||
        context->q_complex_count > std::numeric_limits<PetscInt>::max() / 2 ||
        context->q_split_count != 2 * context->q_complex_count ||
        (context->phase_sign != -1 && context->phase_sign != 1) ||
        context->q_complex_count > static_cast<PetscInt>(std::numeric_limits<int>::max()) ||
        context->q_split_count > static_cast<PetscInt>(std::numeric_limits<int>::max()) ||
        !std::isfinite(operator_normalization_scale) ||
        !std::isfinite(preconditioner_normalization_scale)) {
        out->reason = "invalid_action_context";
        return false;
    }
    out->q_complex_dof_count = static_cast<int>(context->q_complex_count);
    out->real_split_dimension = static_cast<int>(context->q_split_count);
    out->context_phase_sign = context->phase_sign;

    Vec x0 = nullptr;
    Vec x1 = nullptr;
    Vec xsum = nullptr;
    Vec xhalf = nullptr;
    Vec xdouble = nullptr;
    Vec xtiny = nullptr;
    Vec output0 = nullptr;
    Vec output_repeat = nullptr;
    Vec output_third = nullptr;
    Vec output_half = nullptr;
    Vec output_double = nullptr;
    Vec output_tiny = nullptr;
    Vec output1 = nullptr;
    Vec output_sum = nullptr;
    Vec magnetic = nullptr;
    Vec feedback = nullptr;
    Vec combined = nullptr;
    Vec rotated_magnetic = nullptr;
    Vec rotated_feedback = nullptr;
    Vec rotated_combined = nullptr;
    Vec phi_rhs = nullptr;
    Vec phi_solution = nullptr;
    Vec potential_rhs = nullptr;
    Vec potential_residual = nullptr;
    Vec defect = nullptr;
    const PetscInt q_size = context->q_split_count;
    const PetscInt phi_size = context->phi_split_count;
    auto destroy_vectors = [&]() noexcept {
        VecDestroy(&defect);
        VecDestroy(&potential_residual);
        VecDestroy(&potential_rhs);
        VecDestroy(&phi_solution);
        VecDestroy(&phi_rhs);
        VecDestroy(&rotated_combined);
        VecDestroy(&rotated_feedback);
        VecDestroy(&rotated_magnetic);
        VecDestroy(&combined);
        VecDestroy(&feedback);
        VecDestroy(&magnetic);
        VecDestroy(&output_sum);
        VecDestroy(&output1);
        VecDestroy(&output_tiny);
        VecDestroy(&output_double);
        VecDestroy(&output_half);
        VecDestroy(&output_third);
        VecDestroy(&output_repeat);
        VecDestroy(&output0);
        VecDestroy(&xtiny);
        VecDestroy(&xdouble);
        VecDestroy(&xhalf);
        VecDestroy(&xsum);
        VecDestroy(&x1);
        VecDestroy(&x0);
    };
    auto fail = [&](const char *reason) {
        out->status = "failed";
        out->reason = reason;
        destroy_vectors();
        return false;
    };
    auto create_vector = [](PetscInt size, Vec *vector) {
        return vector != nullptr && VecCreateSeq(PETSC_COMM_SELF, size, vector) == 0;
    };
    if (!create_vector(q_size, &x0) || !create_vector(q_size, &x1) ||
        !create_vector(q_size, &xsum) || !create_vector(q_size, &xhalf) ||
        !create_vector(q_size, &xdouble) || !create_vector(q_size, &xtiny) ||
        !create_vector(q_size, &output0) || !create_vector(q_size, &output_repeat) ||
        !create_vector(q_size, &output_third) || !create_vector(q_size, &output_half) ||
        !create_vector(q_size, &output_double) || !create_vector(q_size, &output_tiny) ||
        !create_vector(q_size, &output1) || !create_vector(q_size, &output_sum) ||
        !create_vector(q_size, &magnetic) || !create_vector(q_size, &feedback) ||
        !create_vector(q_size, &combined) || !create_vector(q_size, &rotated_magnetic) ||
        !create_vector(q_size, &rotated_feedback) || !create_vector(q_size, &rotated_combined) ||
        !create_vector(phi_size, &phi_rhs) || !create_vector(phi_size, &phi_solution) ||
        !create_vector(phi_size, &potential_rhs) ||
        !create_vector(phi_size, &potential_residual) || !create_vector(q_size, &defect)) {
        return fail("workspace_allocation_failed");
    }
    PetscScalar *x0_values = nullptr;
    PetscScalar *x1_values = nullptr;
    if (VecGetArray(x0, &x0_values) != 0 || VecGetArray(x1, &x1_values) != 0 ||
        x0_values == nullptr || x1_values == nullptr) {
        if (x0_values != nullptr) {
            VecRestoreArray(x0, &x0_values);
        }
        if (x1_values != nullptr) {
            VecRestoreArray(x1, &x1_values);
        }
        return fail("input_workspace_access_failed");
    }
    for (PetscInt index = 0; index < q_size; ++index) {
        const std::uint64_t stable_index = static_cast<std::uint64_t>(index);
        const int first = static_cast<int>((stable_index * 17u + 3u) % 31u) - 15;
        const int second = static_cast<int>((stable_index * 29u + 11u) % 37u) - 18;
        x0_values[index] = static_cast<PetscScalar>(first) / 15.0;
        x1_values[index] = static_cast<PetscScalar>(second) / 18.0;
    }
    const PetscErrorCode restore_x0_error = VecRestoreArray(x0, &x0_values);
    const PetscErrorCode restore_x1_error = VecRestoreArray(x1, &x1_values);
    if (restore_x0_error != 0 || restore_x1_error != 0 ||
        VecCopy(x0, xsum) != 0 || VecAXPY(xsum, static_cast<PetscScalar>(1.0), x1) != 0 ||
        VecCopy(x0, xhalf) != 0 || VecScale(xhalf, static_cast<PetscScalar>(0.5)) != 0 ||
        VecCopy(x0, xdouble) != 0 || VecScale(xdouble, static_cast<PetscScalar>(2.0)) != 0 ||
        VecCopy(x0, xtiny) != 0 || VecScale(xtiny, static_cast<PetscScalar>(1.0e-12)) != 0) {
        return fail("input_workspace_initialization_failed");
    }

    auto update_max = [](double *target, double value) {
        if (target == nullptr || !std::isfinite(value)) {
            return false;
        }
        if (!std::isfinite(*target)) {
            *target = value;
        } else {
            *target = std::max(*target, value);
        }
        return true;
    };
    auto update_min = [](double *target, double value) {
        if (target == nullptr || !std::isfinite(value)) {
            return false;
        }
        if (!std::isfinite(*target)) {
            *target = value;
        } else {
            *target = std::min(*target, value);
        }
        return true;
    };
    auto relative_vector_defect = [&](Vec lhs, Vec rhs, double rhs_scale) {
        PetscReal lhs_norm = 0.0;
        PetscReal rhs_norm = 0.0;
        PetscReal defect_norm = 0.0;
        if (VecCopy(lhs, defect) != 0 ||
            VecAXPY(defect, static_cast<PetscScalar>(-rhs_scale), rhs) != 0 ||
            VecNorm(lhs, NORM_2, &lhs_norm) != 0 ||
            VecNorm(rhs, NORM_2, &rhs_norm) != 0 ||
            VecNorm(defect, NORM_2, &defect_norm) != 0) {
            return std::numeric_limits<double>::quiet_NaN();
        }
        const double denominator = std::max(
            std::max(static_cast<double>(lhs_norm),
                     std::abs(rhs_scale) * static_cast<double>(rhs_norm)),
            std::numeric_limits<double>::min());
        return static_cast<double>(defect_norm) / denominator;
    };
    auto measure_action = [&](Vec input, Vec output) {
        const PetscErrorCode component_error = apply_native_floquet_schur_components(
            context,
            input,
            magnetic,
            feedback,
            phi_rhs,
            phi_solution,
            potential_rhs);
        if (component_error != 0) {
            return false;
        }
        if (MatMult(context->p, phi_solution, potential_residual) != 0 ||
            VecAXPY(potential_residual, static_cast<PetscScalar>(1.0), potential_rhs) != 0) {
            return false;
        }
        PetscReal rhs_norm = 0.0;
        PetscReal potential_residual_norm = 0.0;
        PetscReal magnetic_norm = 0.0;
        PetscReal feedback_norm = 0.0;
        PetscReal combined_norm = 0.0;
        if (VecNorm(potential_rhs, NORM_2, &rhs_norm) != 0 ||
            VecNorm(potential_residual, NORM_2, &potential_residual_norm) != 0 ||
            VecNorm(magnetic, NORM_2, &magnetic_norm) != 0 ||
            VecNorm(feedback, NORM_2, &feedback_norm) != 0 ||
            VecCopy(magnetic, combined) != 0 ||
            VecAXPY(combined, static_cast<PetscScalar>(1.0), feedback) != 0 ||
            VecNorm(combined, NORM_2, &combined_norm) != 0 ||
            VecCopy(magnetic, rotated_magnetic) != 0 ||
            VecCopy(feedback, rotated_feedback) != 0 ||
            VecCopy(combined, rotated_combined) != 0 ||
            rotate_native_floquet_vector_in_place(context, rotated_magnetic) != 0 ||
            rotate_native_floquet_vector_in_place(context, rotated_feedback) != 0 ||
            rotate_native_floquet_vector_in_place(context, rotated_combined) != 0 ||
            VecCopy(rotated_combined, output) != 0) {
            return false;
        }
        const double rhs_norm_double = static_cast<double>(rhs_norm);
        const double potential_denominator = std::max(
            rhs_norm_double, std::numeric_limits<double>::min());
        const double potential_relative_residual =
            static_cast<double>(potential_residual_norm) / potential_denominator;
        const double cancellation_ratio = static_cast<double>(combined_norm) /
            std::max(static_cast<double>(magnetic_norm) +
                         static_cast<double>(feedback_norm),
                     std::numeric_limits<double>::min());
        if (!std::isfinite(rhs_norm_double) ||
            !std::isfinite(potential_relative_residual) ||
            !std::isfinite(cancellation_ratio) ||
            !update_max(&out->max_potential_relative_residual,
                        potential_relative_residual) ||
            !update_max(&out->max_magnetic_l2_norm,
                        static_cast<double>(magnetic_norm)) ||
            !update_max(&out->max_feedback_l2_norm,
                        static_cast<double>(feedback_norm)) ||
            !update_max(&out->max_combined_l2_norm,
                        static_cast<double>(combined_norm)) ||
            !update_min(&out->min_rhs_l2_norm, rhs_norm_double) ||
            !update_max(&out->max_rhs_l2_norm, rhs_norm_double) ||
            !update_min(&out->min_cancellation_ratio, cancellation_ratio)) {
            return false;
        }
        if (static_cast<double>(combined_norm) > std::numeric_limits<double>::min()) {
            ++out->nonzero_signal_count;
        }
        ++out->action_count;
        return true;
    };
    if (!measure_action(x0, output0) || !measure_action(x0, output_repeat) ||
        !measure_action(x0, output_third) || !measure_action(xhalf, output_half) ||
        !measure_action(xdouble, output_double) || !measure_action(xtiny, output_tiny) ||
        !measure_action(x1, output1) || !measure_action(xsum, output_sum)) {
        return fail("schur_action_measurement_failed");
    }
    const double repeatability_first =
        relative_vector_defect(output_repeat, output0, 1.0);
    const double repeatability_second =
        relative_vector_defect(output_third, output0, 1.0);
    const double homogeneity_half =
        relative_vector_defect(output_half, output0, 0.5);
    const double homogeneity_double =
        relative_vector_defect(output_double, output0, 2.0);
    const double homogeneity_tiny =
        relative_vector_defect(output_tiny, output0, 1.0e-12);
    if (!std::isfinite(repeatability_first) ||
        !std::isfinite(repeatability_second) ||
        !std::isfinite(homogeneity_half) ||
        !std::isfinite(homogeneity_double) ||
        !std::isfinite(homogeneity_tiny)) {
        return fail("nonfinite_action_defect");
    }
    out->repeatability_first_relative_defect = repeatability_first;
    out->repeatability_second_relative_defect = repeatability_second;
    out->max_repeatability_relative_defect = std::max(
        repeatability_first, repeatability_second);
    out->homogeneity_half_relative_defect = homogeneity_half;
    out->homogeneity_double_relative_defect = homogeneity_double;
    out->homogeneity_tiny_relative_defect = homogeneity_tiny;
    out->max_homogeneity_relative_defect = std::max({
        homogeneity_half, homogeneity_double, homogeneity_tiny});
    PetscReal additivity_norm = 0.0;
    PetscReal sum_norm = 0.0;
    PetscReal first_norm = 0.0;
    PetscReal second_norm = 0.0;
    if (VecCopy(output_sum, defect) != 0 ||
        VecAXPY(defect, static_cast<PetscScalar>(-1.0), output0) != 0 ||
        VecAXPY(defect, static_cast<PetscScalar>(-1.0), output1) != 0 ||
        VecNorm(defect, NORM_2, &additivity_norm) != 0 ||
        VecNorm(output_sum, NORM_2, &sum_norm) != 0 ||
        VecNorm(output0, NORM_2, &first_norm) != 0 ||
        VecNorm(output1, NORM_2, &second_norm) != 0) {
        return fail("additivity_measurement_failed");
    }
    out->additivity_relative_defect = static_cast<double>(additivity_norm) /
        std::max({static_cast<double>(sum_norm),
                  static_cast<double>(first_norm) + static_cast<double>(second_norm),
                  std::numeric_limits<double>::min()});
    if (!std::isfinite(out->max_repeatability_relative_defect) ||
        !std::isfinite(out->max_homogeneity_relative_defect) ||
        !std::isfinite(out->additivity_relative_defect)) {
        return fail("nonfinite_action_defect");
    }

    // Reapply the same callback used by the production MatShell once, but
    // through an isolated context copy.  Only the scalar KSP and immutable
    // block matrices are shared; all callback scratch vectors and the error
    // buffer belong to the clone and are destroyed before this workspace.
    NativeFloquetMatShellContext callback_context = *context;
    callback_context.error_message[0] = '\0';
    callback_context.phi_rhs = nullptr;
    callback_context.phi_solution = nullptr;
    callback_context.feedback = nullptr;
    Mat callback_shell = nullptr;
    Vec callback_phi_rhs = nullptr;
    Vec callback_phi_solution = nullptr;
    Vec callback_feedback = nullptr;
    auto destroy_callback_clone = [&]() noexcept {
        if (callback_shell != nullptr) {
            MatDestroy(&callback_shell);
        }
        VecDestroy(&callback_feedback);
        VecDestroy(&callback_phi_solution);
        VecDestroy(&callback_phi_rhs);
    };
    if (VecDuplicate(context->phi_rhs, &callback_phi_rhs) != 0 ||
        VecDuplicate(context->phi_solution, &callback_phi_solution) != 0 ||
        VecDuplicate(context->feedback, &callback_feedback) != 0) {
        destroy_callback_clone();
        return fail("mat_shell_clone_workspace_allocation_failed");
    }
    callback_context.phi_rhs = callback_phi_rhs;
    callback_context.phi_solution = callback_phi_solution;
    callback_context.feedback = callback_feedback;
    if (MatCreateShell(
            PETSC_COMM_SELF,
            q_size,
            q_size,
            q_size,
            q_size,
            &callback_context,
            &callback_shell) != 0 ||
        MatShellSetOperation(
            callback_shell,
            MATOP_MULT,
            reinterpret_cast<void (*)(void)>(native_floquet_matmult)) != 0) {
        destroy_callback_clone();
        return fail("mat_shell_clone_creation_failed");
    }
    const PetscErrorCode callback_error =
        native_floquet_matmult(callback_shell, x0, output_repeat);
    if (callback_error != 0) {
        destroy_callback_clone();
        return fail("mat_shell_callback_measurement_failed");
    }
    ++out->action_count;
    out->mat_shell_reconstruction_relative_defect =
        relative_vector_defect(output_repeat, output0, 1.0);
    if (!std::isfinite(out->mat_shell_reconstruction_relative_defect)) {
        destroy_callback_clone();
        return fail("nonfinite_mat_shell_reconstruction_defect");
    }
    destroy_callback_clone();
    out->available = true;
    out->status = "measured";
    out->reason = "bounded_action_and_matshell_observation";
    destroy_vectors();
    return true;
}

void destroy_native_floquet_context(NativeFloquetMatShellContext *context) noexcept
{
    if (context == nullptr) {
        return;
    }
    if (context->feedback != nullptr) {
        VecDestroy(&context->feedback);
    }
    if (context->q_physical_imag != nullptr) {
        VecDestroy(&context->q_physical_imag);
    }
    if (context->q_physical_real != nullptr) {
        VecDestroy(&context->q_physical_real);
    }
    if (context->phi_solution != nullptr) {
        VecDestroy(&context->phi_solution);
    }
    if (context->phi_rhs != nullptr) {
        VecDestroy(&context->phi_rhs);
    }
    if (context->p_ksp != nullptr) {
        KSPDestroy(&context->p_ksp);
    }
    if (context->p != nullptr) {
        MatDestroy(&context->p);
    }
    if (context->rotated_a_qq != nullptr) {
        MatDestroy(&context->rotated_a_qq);
    }
    if (context->a_phiq != nullptr) {
        MatDestroy(&context->a_phiq);
    }
    if (context->a_qphi != nullptr) {
        MatDestroy(&context->a_qphi);
    }
    if (context->a_qq != nullptr) {
        MatDestroy(&context->a_qq);
    }
}

struct ReusableFloquetWindowState {
    NativeFloquetMatShellContext context{};
    Mat shell = nullptr;
    Mat gyrotropic = nullptr;
    const FloquetSharedDomainSparseModalOperator *operator_identity = nullptr;
    const char *boundary_kind = nullptr;
    const char *gauge_policy = nullptr;
    std::array<double, 3> k_rad_per_m{};
    double mu0_T_m_A = 0.0;
    int phase_sign = 0;
    double applied_normalization_scale = 1.0;
    double residual_tolerance = 0.0;
    int max_linear_iterations = 0;
    double poisson_ksp_rtol = 0.0;
    double poisson_ksp_atol = 0.0;
    int poisson_ksp_max_iterations = 0;
    bool initialized = false;
    // A hard EPSSolve failure can leave SLEPc holding borrowed DS/Mat views.
    // Such a state is permanently unusable and must never be entered by a
    // later subwindow.
    bool invalidated = false;
    // When EPSDestroy is unsafe after a hard PETSc/SLEPc error, all objects
    // reachable from the EPS are intentionally process-bounded leaks.  This
    // keeps their matrices alive until OS teardown instead of destroying a
    // view still owned by SLEPc.
    bool eps_lifetime_unsafe = false;
    bool demag_probe_completed = false;
    FloquetDemagOperatorProbeResult demag_probe{};
};

void destroy_reusable_floquet_window_state(
    ReusableFloquetWindowState *state) noexcept
{
    if (state == nullptr) {
        return;
    }
    if (state->eps_lifetime_unsafe) {
        return;
    }
    if (state->shell != nullptr) {
        MatDestroy(&state->shell);
    }
    if (state->gyrotropic != nullptr) {
        MatDestroy(&state->gyrotropic);
    }
    destroy_native_floquet_context(&state->context);
    state->operator_identity = nullptr;
    state->boundary_kind = nullptr;
    state->gauge_policy = nullptr;
    state->k_rad_per_m = {};
    state->mu0_T_m_A = 0.0;
    state->phase_sign = 0;
    state->applied_normalization_scale = 1.0;
    state->residual_tolerance = 0.0;
    state->max_linear_iterations = 0;
    state->poisson_ksp_rtol = 0.0;
    state->poisson_ksp_atol = 0.0;
    state->poisson_ksp_max_iterations = 0;
    state->initialized = false;
    state->invalidated = false;
    state->eps_lifetime_unsafe = false;
    state->demag_probe_completed = false;
    state->demag_probe = FloquetDemagOperatorProbeResult{};
}

void destroy_opaque_floquet_window_context(void *opaque) noexcept
{
    auto *state = static_cast<ReusableFloquetWindowState *>(opaque);
    if (state == nullptr) {
        return;
    }
    if (state->eps_lifetime_unsafe) {
        // See the state comment: deleting the owner here would leave an
        // undestroyed EPS referring to freed PETSc matrices.
        return;
    }
    destroy_reusable_floquet_window_state(state);
    delete state;
}

struct ReusableFloquetWindowStateDeleter {
    void operator()(ReusableFloquetWindowState *state) const noexcept
    {
        destroy_opaque_floquet_window_context(state);
    }
};

using ReusableFloquetWindowStateOwner =
    std::unique_ptr<ReusableFloquetWindowState,
                    ReusableFloquetWindowStateDeleter>;

bool solve_native_floquet_phi_for_vector(
    NativeFloquetMatShellContext *context,
    Vec q,
    std::vector<double> &out_phi)
{
    if (context == nullptr || q == nullptr ||
        MatMult(context->a_phiq, q, context->phi_rhs) != 0 ||
        VecScale(context->phi_rhs, static_cast<PetscScalar>(-1.0)) != 0 ||
        KSPSolve(context->p_ksp, context->phi_rhs, context->phi_solution) != 0) {
        return false;
    }
    KSPConvergedReason reason = KSP_CONVERGED_ITERATING;
    if (KSPGetConvergedReason(context->p_ksp, &reason) != 0 || reason < 0) {
        return false;
    }
    const PetscScalar *values = nullptr;
    if (VecGetArrayRead(context->phi_solution, &values) != 0) {
        return false;
    }
    out_phi.resize(static_cast<std::size_t>(context->phi_split_count));
    for (PetscInt index = 0; index < context->phi_split_count; ++index) {
        out_phi[static_cast<std::size_t>(index)] =
            static_cast<double>(PetscRealPart(values[index]));
    }
    VecRestoreArrayRead(context->phi_solution, &values);
    return true;
}

Complex complex_inner_product(
    const std::vector<Complex> &left,
    const std::vector<Complex> &right) noexcept
{
    if (left.size() != right.size()) {
        return Complex(std::numeric_limits<double>::infinity(), 0.0);
    }
    Complex value{};
    for (std::size_t index = 0u; index < left.size(); ++index) {
        value += std::conj(left[index]) * right[index];
    }
    return value;
}

bool solve_floquet_demag_probe_sample(
    NativeFloquetMatShellContext *context,
    const FloquetSharedDomainSparseModalOperator &operator_view,
    const std::vector<double> &probe_values,
    FloquetDemagOperatorProbeSample *out_sample,
    std::vector<Complex> &out_q,
    std::vector<Complex> &out_phi)
{
    if (context == nullptr || out_sample == nullptr ||
        probe_values.size() != static_cast<std::size_t>(context->q_complex_count) ||
        context->q_physical_real == nullptr) {
        return false;
    }
    out_q.assign(probe_values.size(), Complex{});
    for (std::size_t index = 0u; index < probe_values.size(); ++index) {
        out_q[index] = Complex(probe_values[index], 0.0);
    }
    out_sample->q_l2_norm = complex_vector_norm(out_q);
    const double zero_threshold = 64.0 * std::numeric_limits<double>::epsilon() *
        std::sqrt(static_cast<double>(probe_values.size()));
    if (!std::isfinite(out_sample->q_l2_norm)) {
        return false;
    }
    if (out_sample->q_l2_norm <= zero_threshold) {
        out_sample->attempted = false;
        return true;
    }

    PetscInt split_size = 0;
    if (VecGetSize(context->q_physical_real, &split_size) != 0 ||
        split_size != 2 * context->q_complex_count ||
        VecSet(context->q_physical_real, static_cast<PetscScalar>(0.0)) != 0) {
        return false;
    }
    PetscScalar *split_values = nullptr;
    if (VecGetArray(context->q_physical_real, &split_values) != 0) {
        return false;
    }
    for (PetscInt index = 0; index < context->q_complex_count; ++index) {
        split_values[index] = static_cast<PetscScalar>(
            probe_values[static_cast<std::size_t>(index)]);
        split_values[context->q_complex_count + index] = static_cast<PetscScalar>(0.0);
    }
    const PetscErrorCode restore_code =
        VecRestoreArray(context->q_physical_real, &split_values);
    if (restore_code != 0) {
        return false;
    }

    std::vector<double> phi_split;
    if (!solve_native_floquet_phi_for_vector(
            context, context->q_physical_real, phi_split) ||
        phi_split.size() != static_cast<std::size_t>(context->phi_split_count) ||
        context->phi_split_count != 2 * static_cast<PetscInt>(operator_view.phi_dof_count)) {
        return false;
    }
    out_phi.resize(static_cast<std::size_t>(operator_view.phi_dof_count));
    for (std::size_t index = 0u; index < out_phi.size(); ++index) {
        out_phi[index] = Complex(
            phi_split[index], phi_split[out_phi.size() + index]);
    }

    out_sample->attempted = true;
    out_sample->potential_relative_residual =
        floquet_potential_residual(operator_view, out_q, out_phi);
    const std::vector<Complex> p_phi = complex_csr_matvec(*operator_view.p, out_phi);
    const std::vector<Complex> a_qphi_phi =
        complex_csr_matvec(*operator_view.a_qphi, out_phi);
    if (p_phi.size() != out_phi.size() || a_qphi_phi.size() != out_q.size()) {
        return false;
    }
    const Complex potential_quadratic = complex_inner_product(out_phi, p_phi);
    const Complex feedback_quadratic = complex_inner_product(out_q, a_qphi_phi);
    out_sample->potential_energy_j =
        0.5 * operator_view.mu0_T_m_A * potential_quadratic.real();
    out_sample->self_energy_j = 0.5 * feedback_quadratic.real();
    out_sample->passed = std::isfinite(out_sample->potential_relative_residual) &&
        out_sample->potential_relative_residual <= kFloquetDemagProbeRelativeTolerance &&
        std::isfinite(potential_quadratic.real()) &&
        std::isfinite(feedback_quadratic.real()) &&
        std::isfinite(out_sample->potential_energy_j) &&
        std::isfinite(out_sample->self_energy_j);
    return true;
}

bool run_floquet_demag_operator_probe(
    NativeFloquetMatShellContext *context,
    const FloquetSharedDomainSparseModalOperator &operator_view,
    FloquetDemagOperatorProbeResult *out_probe)
{
    if (context == nullptr || out_probe == nullptr) {
        return false;
    }
    *out_probe = FloquetDemagOperatorProbeResult{};
    if (operator_view.uniform_transverse_probe_q_y == nullptr &&
        operator_view.uniform_transverse_probe_q_z == nullptr) {
        return true;
    }
    out_probe->requested = true;
    if (operator_view.uniform_transverse_probe_q_y == nullptr ||
        operator_view.uniform_transverse_probe_q_z == nullptr) {
        return false;
    }

    std::vector<Complex> q_y;
    std::vector<Complex> q_z;
    std::vector<Complex> phi_y;
    std::vector<Complex> phi_z;
    if (!solve_floquet_demag_probe_sample(
            context,
            operator_view,
            *operator_view.uniform_transverse_probe_q_y,
            &out_probe->global_y,
            q_y,
            phi_y) ||
        !solve_floquet_demag_probe_sample(
            context,
            operator_view,
            *operator_view.uniform_transverse_probe_q_z,
            &out_probe->global_z,
            q_z,
            phi_z)) {
        return false;
    }

    const bool both_directions_observable =
        out_probe->global_y.attempted && out_probe->global_z.attempted;
    out_probe->available = both_directions_observable;
    if ((out_probe->global_y.attempted && !out_probe->global_y.passed) ||
        (out_probe->global_z.attempted && !out_probe->global_z.passed)) {
        out_probe->passed = false;
        return false;
    }
    if (!both_directions_observable) {
        out_probe->passed = false;
        return true;
    }

    const std::vector<Complex> a_qphi_phi_y =
        complex_csr_matvec(*operator_view.a_qphi, phi_y);
    const std::vector<Complex> a_qphi_phi_z =
        complex_csr_matvec(*operator_view.a_qphi, phi_z);
    if (a_qphi_phi_y.size() != q_y.size() || a_qphi_phi_z.size() != q_z.size()) {
        return false;
    }
    const Complex cross_yz = complex_inner_product(q_y, a_qphi_phi_z);
    const Complex cross_zy = complex_inner_product(q_z, a_qphi_phi_y);
    const double cross_scale = std::max(
        {std::abs(cross_yz), std::abs(cross_zy),
         std::abs(out_probe->global_y.self_energy_j),
         std::abs(out_probe->global_z.self_energy_j),
         std::numeric_limits<double>::min()});
    out_probe->hermitian_relative_defect =
        std::abs(cross_yz - std::conj(cross_zy)) / cross_scale;

    const double energy_scale = std::max(
        {std::abs(out_probe->global_y.self_energy_j),
         std::abs(out_probe->global_z.self_energy_j),
         std::abs(out_probe->global_y.potential_energy_j),
         std::abs(out_probe->global_z.potential_energy_j),
         std::numeric_limits<double>::min()});
    const double negative_energy_tolerance =
        kFloquetDemagProbeRelativeTolerance * energy_scale;
    for (FloquetDemagOperatorProbeSample *sample :
         {&out_probe->global_y, &out_probe->global_z}) {
        sample->energy_form_relative_defect =
            std::abs(sample->self_energy_j - sample->potential_energy_j) / energy_scale;
        sample->passed = sample->passed &&
            sample->self_energy_j >= -negative_energy_tolerance &&
            sample->potential_energy_j >= -negative_energy_tolerance &&
            sample->energy_form_relative_defect <=
                kFloquetDemagProbeRelativeTolerance;
    }
    out_probe->passed = out_probe->global_y.passed && out_probe->global_z.passed &&
        std::isfinite(out_probe->hermitian_relative_defect) &&
        out_probe->hermitian_relative_defect <= kFloquetDemagProbeRelativeTolerance;
    return out_probe->passed;
}

bool solve_native_floquet_phi_for_physical_mode(
    NativeFloquetMatShellContext *context,
    Vec xr,
    Vec xi,
    std::vector<Complex> &out_phi)
{
    if (context == nullptr || xr == nullptr || xi == nullptr ||
        context->q_physical_real == nullptr || context->q_physical_imag == nullptr ||
        context->q_complex_count <= 0) {
        return false;
    }
    PetscInt real_size = 0;
    PetscInt imag_size = 0;
    if (VecGetSize(xr, &real_size) != 0 || VecGetSize(xi, &imag_size) != 0 ||
        real_size != context->q_split_count || imag_size != context->q_split_count) {
        return false;
    }

    const PetscScalar *real_values = nullptr;
    const PetscScalar *imag_values = nullptr;
    PetscScalar *q_real_values = nullptr;
    PetscScalar *q_imag_values = nullptr;
    const PetscInt q_count = context->q_complex_count;
    if (VecGetArrayRead(xr, &real_values) != 0 ||
        VecGetArrayRead(xi, &imag_values) != 0 ||
        VecGetArray(context->q_physical_real, &q_real_values) != 0 ||
        VecGetArray(context->q_physical_imag, &q_imag_values) != 0) {
        if (real_values != nullptr) {
            VecRestoreArrayRead(xr, &real_values);
        }
        if (imag_values != nullptr) {
            VecRestoreArrayRead(xi, &imag_values);
        }
        if (q_real_values != nullptr) {
            VecRestoreArray(context->q_physical_real, &q_real_values);
        }
        if (q_imag_values != nullptr) {
            VecRestoreArray(context->q_physical_imag, &q_imag_values);
        }
        return false;
    }
    for (PetscInt index = 0; index < q_count; ++index) {
        // EPS stores a (possibly complex) eigenvector of the real-split
        // rotated pencil as x = x_r + i*x_i.  The physical q is obtained by
        // collapsing the two split blocks, q = x[0:q] + i*x[q:2q].
        const PetscScalar physical_real =
            real_values[index] - imag_values[q_count + index];
        const PetscScalar physical_imag =
            imag_values[index] + real_values[q_count + index];
        q_real_values[index] = physical_real;
        q_real_values[q_count + index] = physical_imag;
        q_imag_values[index] = 0.0;
        q_imag_values[q_count + index] = 0.0;
    }
    VecRestoreArrayRead(xr, &real_values);
    VecRestoreArrayRead(xi, &imag_values);
    VecRestoreArray(context->q_physical_real, &q_real_values);
    VecRestoreArray(context->q_physical_imag, &q_imag_values);

    std::vector<double> phi_split;
    if (!solve_native_floquet_phi_for_vector(
            context, context->q_physical_real, phi_split) ||
        phi_split.size() != static_cast<std::size_t>(context->phi_split_count) ||
        context->phi_split_count % 2 != 0) {
        return false;
    }
    const PetscInt phi_count = context->phi_split_count / 2;
    out_phi.resize(static_cast<std::size_t>(phi_count));
    for (PetscInt index = 0; index < phi_count; ++index) {
        // q_physical_real carries the complete real split [Re(q), Im(q)].
        // Solving that split system once produces [Re(phi), Im(phi)] for the
        // same physical complex q.  Solving separate real and imaginary
        // right-hand sides would erase the phase of q before the Poisson
        // reconstruction and is incorrect for genuine nonzero-k modes.
        out_phi[static_cast<std::size_t>(index)] = Complex(
            phi_split[static_cast<std::size_t>(index)],
            phi_split[static_cast<std::size_t>(phi_count + index)]);
    }
    return true;
}

bool copy_native_floquet_eigenvector(
    Vec xr,
    Vec xi,
    PetscInt size,
    std::vector<Complex> &out)
{
    const PetscScalar *real_values = nullptr;
    const PetscScalar *imag_values = nullptr;
    if (VecGetArrayRead(xr, &real_values) != 0 ||
        VecGetArrayRead(xi, &imag_values) != 0) {
        if (real_values != nullptr) {
            VecRestoreArrayRead(xr, &real_values);
        }
        if (imag_values != nullptr) {
            VecRestoreArrayRead(xi, &imag_values);
        }
        return false;
    }
    out.resize(static_cast<std::size_t>(size));
    for (PetscInt index = 0; index < size; ++index) {
        out[static_cast<std::size_t>(index)] = Complex(
            static_cast<double>(PetscRealPart(real_values[index])),
            static_cast<double>(PetscRealPart(imag_values[index])));
    }
    VecRestoreArrayRead(xr, &real_values);
    VecRestoreArrayRead(xi, &imag_values);
    return true;
}

bool floquet_dense_oracle_requested() noexcept
{
    const char *value = std::getenv("FULLMAG_FLOQUET_DENSE_ORACLE");
    return value != nullptr && std::strcmp(value, "1") == 0;
}

bool copy_sparse_matrix_to_dense(
    Mat sparse,
    PetscInt dimension,
    Mat *dense) noexcept
{
    if (sparse == nullptr || dense == nullptr || dimension <= 0 ||
        MatCreateSeqDense(PETSC_COMM_SELF, dimension, dimension, nullptr, dense) != 0) {
        return false;
    }
    for (PetscInt row = 0; row < dimension; ++row) {
        PetscInt nonzero_count = 0;
        const PetscInt *columns = nullptr;
        const PetscScalar *values = nullptr;
        if (MatGetRow(sparse, row, &nonzero_count, &columns, &values) != 0) {
            MatDestroy(dense);
            return false;
        }
        bool ok = true;
        for (PetscInt entry = 0; entry < nonzero_count; ++entry) {
            if (MatSetValue(
                    *dense,
                    row,
                    columns[entry],
                    values[entry],
                    INSERT_VALUES) != 0) {
                ok = false;
                break;
            }
        }
        if (MatRestoreRow(
                sparse, row, &nonzero_count, &columns, &values) != 0 || !ok) {
            MatDestroy(dense);
            return false;
        }
    }
    if (MatAssemblyBegin(*dense, MAT_FINAL_ASSEMBLY) != 0 ||
        MatAssemblyEnd(*dense, MAT_FINAL_ASSEMBLY) != 0) {
        MatDestroy(dense);
        return false;
    }
    return true;
}

bool set_real_split_vector_from_complex(
    Vec vector,
    const std::vector<Complex> &values) noexcept
{
    if (vector == nullptr || values.empty()) {
        return false;
    }
    PetscInt dimension = 0;
    if (VecGetSize(vector, &dimension) != 0 ||
        dimension != static_cast<PetscInt>(2u * values.size()) ||
        VecSet(vector, static_cast<PetscScalar>(0.0)) != 0) {
        return false;
    }
    for (std::size_t index = 0u; index < values.size(); ++index) {
        if (VecSetValue(
                vector,
                static_cast<PetscInt>(index),
                static_cast<PetscScalar>(values[index].real()),
                INSERT_VALUES) != 0 ||
            VecSetValue(
                vector,
                static_cast<PetscInt>(values.size() + index),
                static_cast<PetscScalar>(values[index].imag()),
                INSERT_VALUES) != 0) {
            return false;
        }
    }
    return VecAssemblyBegin(vector) == 0 && VecAssemblyEnd(vector) == 0;
}

bool read_real_split_complex_vector(
    Vec vector,
    std::uint64_t complex_count,
    std::vector<Complex> &out) noexcept
{
    if (vector == nullptr || complex_count == 0u) {
        return false;
    }
    PetscInt dimension = 0;
    if (VecGetSize(vector, &dimension) != 0 ||
        dimension != static_cast<PetscInt>(2u * complex_count)) {
        return false;
    }
    const PetscScalar *values = nullptr;
    if (VecGetArrayRead(vector, &values) != 0) {
        return false;
    }
    out.resize(static_cast<std::size_t>(complex_count));
    for (std::uint64_t index = 0u; index < complex_count; ++index) {
        out[static_cast<std::size_t>(index)] = Complex(
            static_cast<double>(PetscRealPart(values[index])),
            static_cast<double>(PetscRealPart(values[complex_count + index])));
    }
    return VecRestoreArrayRead(vector, &values) == 0;
}

bool run_floquet_dense_original_oracle(
    NativeFloquetMatShellContext *context,
    Mat shell,
    const FloquetSharedDomainSparseModalOperator &operator_view,
    const SLEPcSparseGyrotropicModalEigenRequest &spectral_request,
    double operator_normalization_scale,
    FloquetDenseOracleDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics == nullptr) {
        return false;
    }
    *out_diagnostics = FloquetDenseOracleDiagnostics{};
    if (!floquet_dense_oracle_requested()) {
        return true;
    }
    out_diagnostics->requested = true;
    out_diagnostics->status = "unavailable";
    out_diagnostics->q_complex_dof_count =
        operator_view.q_complex_dof_count <=
                static_cast<std::uint64_t>(std::numeric_limits<int>::max())
            ? static_cast<int>(operator_view.q_complex_dof_count)
            : 0;
    out_diagnostics->phi_dof_count =
        operator_view.phi_dof_count <=
                static_cast<std::uint64_t>(std::numeric_limits<int>::max())
            ? static_cast<int>(operator_view.phi_dof_count)
            : 0;
    out_diagnostics->operator_normalization_scale = operator_normalization_scale;

    if (context == nullptr || shell == nullptr ||
        operator_view.q_complex_dof_count == 0u ||
        operator_view.q_complex_dof_count > 256u ||
        context->q_split_count !=
            static_cast<PetscInt>(2u * operator_view.q_complex_dof_count)) {
        out_diagnostics->reason = "real_split_dimension_exceeds_512_or_invalid";
        return false;
    }
    out_diagnostics->real_split_dimension = context->q_split_count;

    Mat direct_a_qq = nullptr;
    Mat direct_b_qq = nullptr;
    Mat direct_p = nullptr;
    Mat direct_a_qphi = nullptr;
    Mat direct_a_phiq = nullptr;
    Mat dense_schur = nullptr;
    Mat dense_rotated_schur = nullptr;
    Mat dense_b_qq = nullptr;
    KSP oracle_p_ksp = nullptr;
    EPS oracle_eps = nullptr;
    ST oracle_st = nullptr;
    Vec basis = nullptr;
    Vec rhs_phi = nullptr;
    Vec phi_solution = nullptr;
    Vec poisson_residual = nullptr;
    Vec a_qq_column = nullptr;
    Vec feedback_column = nullptr;
    Vec schur_column = nullptr;
    Vec probe = nullptr;
    Vec shell_action = nullptr;
    Vec dense_action = nullptr;
    Vec action_difference = nullptr;
    Vec eigenvector_real = nullptr;
    Vec eigenvector_imag = nullptr;
    Vec physical_q = nullptr;

    auto destroy = [&]() noexcept {
        if (physical_q != nullptr) {
            VecDestroy(&physical_q);
        }
        if (eigenvector_real != nullptr) {
            VecDestroy(&eigenvector_real);
        }
        if (eigenvector_imag != nullptr) {
            VecDestroy(&eigenvector_imag);
        }
        if (action_difference != nullptr) {
            VecDestroy(&action_difference);
        }
        if (dense_action != nullptr) {
            VecDestroy(&dense_action);
        }
        if (shell_action != nullptr) {
            VecDestroy(&shell_action);
        }
        if (probe != nullptr) {
            VecDestroy(&probe);
        }
        if (schur_column != nullptr) {
            VecDestroy(&schur_column);
        }
        if (feedback_column != nullptr) {
            VecDestroy(&feedback_column);
        }
        if (a_qq_column != nullptr) {
            VecDestroy(&a_qq_column);
        }
        if (poisson_residual != nullptr) {
            VecDestroy(&poisson_residual);
        }
        if (phi_solution != nullptr) {
            VecDestroy(&phi_solution);
        }
        if (rhs_phi != nullptr) {
            VecDestroy(&rhs_phi);
        }
        if (basis != nullptr) {
            VecDestroy(&basis);
        }
        if (oracle_eps != nullptr) {
            EPSDestroy(&oracle_eps);
        }
        if (oracle_p_ksp != nullptr) {
            KSPDestroy(&oracle_p_ksp);
        }
        if (dense_b_qq != nullptr) {
            MatDestroy(&dense_b_qq);
        }
        if (dense_rotated_schur != nullptr) {
            MatDestroy(&dense_rotated_schur);
        }
        if (dense_schur != nullptr) {
            MatDestroy(&dense_schur);
        }
        if (direct_a_phiq != nullptr) {
            MatDestroy(&direct_a_phiq);
        }
        if (direct_a_qphi != nullptr) {
            MatDestroy(&direct_a_qphi);
        }
        if (direct_p != nullptr) {
            MatDestroy(&direct_p);
        }
        if (direct_b_qq != nullptr) {
            MatDestroy(&direct_b_qq);
        }
        if (direct_a_qq != nullptr) {
            MatDestroy(&direct_a_qq);
        }
    };
    auto fail = [&](const char *reason) noexcept {
        out_diagnostics->status = "error";
        out_diagnostics->reason = reason;
        destroy();
        return false;
    };

    const PetscInt q_split_count = context->q_split_count;
    const PetscInt phi_split_count = context->phi_split_count;
    const double normalization_scale =
        std::isfinite(operator_normalization_scale) &&
                operator_normalization_scale != 0.0
            ? operator_normalization_scale
            : 1.0;
    if (!create_real_split_matrix(*operator_view.a_qq, &direct_a_qq) ||
        !create_real_split_matrix(*operator_view.b_qq, &direct_b_qq) ||
        !create_real_split_matrix(*operator_view.p, &direct_p) ||
        !create_real_split_matrix(*operator_view.a_qphi, &direct_a_qphi) ||
        !create_real_split_matrix(*operator_view.a_phiq, &direct_a_phiq) ||
        MatScale(direct_a_qq, static_cast<PetscScalar>(normalization_scale)) != 0 ||
        MatScale(direct_a_qphi, static_cast<PetscScalar>(normalization_scale)) != 0 ||
        MatScale(direct_b_qq, static_cast<PetscScalar>(normalization_scale)) != 0 ||
        MatCreateSeqDense(
            PETSC_COMM_SELF,
            q_split_count,
            q_split_count,
            nullptr,
            &dense_schur) != 0 ||
        MatCreateSeqDense(
            PETSC_COMM_SELF,
            q_split_count,
            q_split_count,
            nullptr,
            &dense_rotated_schur) != 0 ||
        !copy_sparse_matrix_to_dense(direct_b_qq, q_split_count, &dense_b_qq)) {
        return fail("dense_oracle_matrix_creation_failed");
    }

    PC oracle_pc = nullptr;
    if (KSPCreate(PETSC_COMM_SELF, &oracle_p_ksp) != 0 ||
        KSPSetOperators(oracle_p_ksp, direct_p, direct_p) != 0 ||
        KSPSetType(oracle_p_ksp, KSPPREONLY) != 0 ||
        KSPGetPC(oracle_p_ksp, &oracle_pc) != 0 ||
        PCSetType(oracle_pc, PCLU) != 0 ||
        PCFactorSetShiftType(oracle_pc, MAT_SHIFT_NONE) != 0 ||
        KSPSetErrorIfNotConverged(oracle_p_ksp, PETSC_TRUE) != 0 ||
        KSPSetUp(oracle_p_ksp) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, q_split_count, &basis) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, phi_split_count, &rhs_phi) != 0 ||
        VecDuplicate(rhs_phi, &phi_solution) != 0 ||
        VecDuplicate(rhs_phi, &poisson_residual) != 0 ||
        VecDuplicate(basis, &a_qq_column) != 0 ||
        VecDuplicate(basis, &feedback_column) != 0 ||
        VecDuplicate(basis, &schur_column) != 0) {
        return fail("dense_oracle_poisson_lu_setup_failed");
    }

    double poisson_residual_max = 0.0;
    for (PetscInt column = 0; column < q_split_count; ++column) {
        if (VecSet(basis, static_cast<PetscScalar>(0.0)) != 0 ||
            VecSetValue(basis, column, static_cast<PetscScalar>(1.0), INSERT_VALUES) != 0 ||
            VecAssemblyBegin(basis) != 0 || VecAssemblyEnd(basis) != 0 ||
            MatMult(direct_a_phiq, basis, rhs_phi) != 0 ||
            VecScale(rhs_phi, static_cast<PetscScalar>(-1.0)) != 0 ||
            KSPSolve(oracle_p_ksp, rhs_phi, phi_solution) != 0) {
            return fail("dense_oracle_poisson_lu_solve_failed");
        }
        KSPConvergedReason reason = KSP_CONVERGED_ITERATING;
        if (KSPGetConvergedReason(oracle_p_ksp, &reason) != 0 || reason < 0 ||
            MatMult(direct_p, phi_solution, poisson_residual) != 0 ||
            VecAXPY(poisson_residual, static_cast<PetscScalar>(-1.0), rhs_phi) != 0) {
            return fail("dense_oracle_poisson_lu_not_converged");
        }
        PetscReal residual_norm = 0.0;
        PetscReal rhs_norm = 0.0;
        if (VecNorm(poisson_residual, NORM_2, &residual_norm) != 0 ||
            VecNorm(rhs_phi, NORM_2, &rhs_norm) != 0) {
            return fail("dense_oracle_poisson_residual_measurement_failed");
        }
        poisson_residual_max = std::max(
            poisson_residual_max,
            static_cast<double>(residual_norm) /
                std::max(static_cast<double>(rhs_norm), std::numeric_limits<double>::min()));
        if (MatMult(direct_a_qq, basis, a_qq_column) != 0 ||
            MatMult(direct_a_qphi, phi_solution, feedback_column) != 0 ||
            VecCopy(a_qq_column, schur_column) != 0 ||
            VecAXPY(schur_column, static_cast<PetscScalar>(1.0), feedback_column) != 0) {
            return fail("dense_oracle_schur_action_failed");
        }
        const PetscScalar *column_values = nullptr;
        if (VecGetArrayRead(schur_column, &column_values) != 0) {
            return fail("dense_oracle_schur_column_read_failed");
        }
        bool column_ok = true;
        for (PetscInt row = 0; row < q_split_count; ++row) {
            if (MatSetValue(
                    dense_schur,
                    row,
                    column,
                    column_values[row],
                    INSERT_VALUES) != 0) {
                column_ok = false;
                break;
            }
        }
        if (VecRestoreArrayRead(schur_column, &column_values) != 0 || !column_ok) {
            return fail("dense_oracle_schur_column_write_failed");
        }
    }
    out_diagnostics->poisson_relative_residual_max = poisson_residual_max;
    if (!std::isfinite(poisson_residual_max)) {
        return fail("dense_oracle_nonfinite_poisson_residual");
    }
    if (MatAssemblyBegin(dense_schur, MAT_FINAL_ASSEMBLY) != 0 ||
        MatAssemblyEnd(dense_schur, MAT_FINAL_ASSEMBLY) != 0) {
        return fail("dense_oracle_schur_assembly_failed");
    }

    const PetscInt q_complex_count = static_cast<PetscInt>(
        operator_view.q_complex_dof_count);
    for (PetscInt row = 0; row < q_split_count; ++row) {
        for (PetscInt column = 0; column < q_split_count; ++column) {
            PetscScalar value = 0.0;
            const PetscInt source_row = row < q_complex_count
                ? q_complex_count + row
                : row - q_complex_count;
            if (MatGetValue(dense_schur, source_row, column, &value) != 0 ||
                MatSetValue(
                    dense_rotated_schur,
                    row,
                    column,
                    static_cast<PetscScalar>(context->phase_sign) *
                        (row < q_complex_count ? value : -value),
                    INSERT_VALUES) != 0) {
                return fail("dense_oracle_rotation_failed");
            }
        }
    }
    if (MatAssemblyBegin(dense_rotated_schur, MAT_FINAL_ASSEMBLY) != 0 ||
        MatAssemblyEnd(dense_rotated_schur, MAT_FINAL_ASSEMBLY) != 0) {
        return fail("dense_oracle_rotation_assembly_failed");
    }

    if (VecCreateSeq(PETSC_COMM_SELF, q_split_count, &probe) != 0 ||
        VecDuplicate(probe, &shell_action) != 0 ||
        VecDuplicate(probe, &dense_action) != 0 ||
        VecDuplicate(probe, &action_difference) != 0) {
        return fail("dense_oracle_action_vector_creation_failed");
    }
    const PetscInt probe_count = std::min<PetscInt>(8, q_split_count);
    double action_error_max = 0.0;
    for (PetscInt probe_index = 0; probe_index < probe_count; ++probe_index) {
        if (VecSet(probe, static_cast<PetscScalar>(0.0)) != 0) {
            return fail("dense_oracle_action_probe_reset_failed");
        }
        if (probe_index < 4) {
            const PetscInt index = probe_index == 2
                ? q_complex_count
                : probe_index == 3 ? q_complex_count + 1 : probe_index;
            if (index < q_split_count &&
                (VecSetValue(
                     probe,
                     index,
                     static_cast<PetscScalar>(1.0),
                     INSERT_VALUES) != 0)) {
                return fail("dense_oracle_basis_probe_failed");
            }
        } else {
            for (PetscInt index = 0; index < q_split_count; ++index) {
                const int pattern = static_cast<int>(
                    ((index + 1) * (probe_index + 3)) % 17) - 8;
                if (VecSetValue(
                        probe,
                        index,
                        static_cast<PetscScalar>(pattern) / 8.0,
                        INSERT_VALUES) != 0) {
                    return fail("dense_oracle_dense_probe_failed");
                }
            }
        }
        if (VecAssemblyBegin(probe) != 0 || VecAssemblyEnd(probe) != 0 ||
            MatMult(shell, probe, shell_action) != 0 ||
            MatMult(dense_rotated_schur, probe, dense_action) != 0 ||
            VecCopy(shell_action, action_difference) != 0 ||
            VecAXPY(action_difference, static_cast<PetscScalar>(-1.0), dense_action) != 0) {
            return fail("dense_oracle_action_comparison_failed");
        }
        PetscReal difference_norm = 0.0;
        PetscReal direct_norm = 0.0;
        if (VecNorm(action_difference, NORM_2, &difference_norm) != 0 ||
            VecNorm(dense_action, NORM_2, &direct_norm) != 0) {
            return fail("dense_oracle_action_norm_failed");
        }
        action_error_max = std::max(
            action_error_max,
            static_cast<double>(difference_norm) /
                std::max(static_cast<double>(direct_norm), std::numeric_limits<double>::min()));
    }
    out_diagnostics->action_probe_count = static_cast<int>(probe_count);
    out_diagnostics->action_relative_error_max = action_error_max;
    out_diagnostics->action_match = std::isfinite(action_error_max) && action_error_max <= 1.0e-10;
    if (!out_diagnostics->action_match) {
        return fail("dense_oracle_shell_action_mismatch");
    }

    if (EPSCreate(PETSC_COMM_SELF, &oracle_eps) != 0 ||
        EPSSetOperators(oracle_eps, dense_rotated_schur, dense_b_qq) != 0 ||
        EPSSetProblemType(oracle_eps, EPS_GNHEP) != 0 ||
        EPSSetType(oracle_eps, EPSLAPACK) != 0 ||
        EPSGetST(oracle_eps, &oracle_st) != 0 ||
        STSetType(oracle_st, STSHIFT) != 0 ||
        STSetShift(oracle_st, static_cast<PetscScalar>(0.0)) != 0 ||
        EPSSetTrueResidual(oracle_eps, PETSC_TRUE) != 0 ||
        EPSSetDimensions(oracle_eps, q_split_count, PETSC_DEFAULT, PETSC_DEFAULT) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, q_split_count, &eigenvector_real) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, q_split_count, &eigenvector_imag) != 0 ||
        EPSSolve(oracle_eps) != 0) {
        return fail("dense_oracle_eps_lapack_failed");
    }
    const char *resolved_st_type = nullptr;
    PetscScalar resolved_shift = 0.0;
    if (STGetType(oracle_st, &resolved_st_type) != 0 ||
        resolved_st_type == nullptr ||
        std::strcmp(resolved_st_type, STSHIFT) != 0 ||
        STGetShift(oracle_st, &resolved_shift) != 0 ||
        PetscAbsScalar(resolved_shift) != 0.0) {
        return fail("dense_oracle_nonzero_spectral_shift");
    }
    out_diagnostics->st_shift_zero = true;
    PetscInt converged_count = 0;
    EPSConvergedReason converged_reason = EPS_CONVERGED_ITERATING;
    if (EPSGetConverged(oracle_eps, &converged_count) != 0 ||
        EPSGetConvergedReason(oracle_eps, &converged_reason) != 0) {
        return fail("dense_oracle_eps_convergence_query_failed");
    }
    out_diagnostics->available = true;
    out_diagnostics->eps_converged_count = static_cast<int>(converged_count);
    out_diagnostics->eps_converged_reason_available = true;
    out_diagnostics->eps_converged_reason = static_cast<int>(converged_reason);
    if (converged_reason <= EPS_CONVERGED_ITERATING) {
        return fail("dense_oracle_eps_not_converged");
    }
    if (converged_count <= 0) {
        return fail("dense_oracle_eps_returned_no_eigenpairs");
    }

    const double target_omega = omega_rad_s_from_frequency_hz(
        std::max(0.0, spectral_request.target_frequency_hz));
    const bool filter_window = spectral_request.frequency_max_hz >
        spectral_request.frequency_min_hz && spectral_request.frequency_max_hz > 0.0;
    const double eigenvalue_imaginary_limit =
        std::max(1.0e-8, 10.0e-12);
    PetscInt selected_index = -1;
    PetscScalar selected_kr = 0.0;
    PetscScalar selected_ki = 0.0;
    double selected_omega = 0.0;
    double selected_imaginary = 0.0;
    double selected_distance = std::numeric_limits<double>::infinity();
    for (PetscInt index = 0; index < converged_count; ++index) {
        PetscScalar kr = 0.0;
        PetscScalar ki = 0.0;
        if (EPSGetEigenpair(
                oracle_eps,
                index,
                &kr,
                &ki,
                eigenvector_real,
                eigenvector_imag) != 0) {
            continue;
        }
        const double omega = static_cast<double>(PetscRealPart(kr));
        const double imaginary = static_cast<double>(PetscRealPart(ki));
        if (!std::isfinite(omega) || !std::isfinite(imaginary) ||
            std::abs(imaginary) > eigenvalue_imaginary_limit *
                std::max(1.0, std::abs(omega))) {
            continue;
        }
        const ModeKinematics kinematics = map_eigenvalue(
            {0.0, static_cast<double>(context->phase_sign) * omega},
            spectral_request.phase_convention);
        if (!select_positive_frequency_mode(
                kinematics,
                ZeroFrequencyModePolicy::exclude) ||
            (filter_window &&
             (kinematics.frequency_hz < spectral_request.frequency_min_hz ||
              kinematics.frequency_hz > spectral_request.frequency_max_hz))) {
            continue;
        }
        std::vector<Complex> trial_split;
        if (!copy_native_floquet_eigenvector(
                eigenvector_real, eigenvector_imag, q_split_count, trial_split)) {
            continue;
        }
        const std::vector<Complex> trial_q = physical_complex_vector_from_split(
            trial_split, operator_view.q_complex_dof_count);
        const double trial_q_norm = complex_vector_norm(trial_q);
        const double trial_split_norm = complex_vector_norm(trial_split);
        if (trial_q.size() != static_cast<std::size_t>(operator_view.q_complex_dof_count) ||
            !std::isfinite(trial_q_norm) || !std::isfinite(trial_split_norm) ||
            trial_q_norm <= std::numeric_limits<double>::epsilon() ||
            trial_q_norm / std::max(
                trial_split_norm, std::numeric_limits<double>::min()) <=
                std::sqrt(std::numeric_limits<double>::epsilon())) {
            continue;
        }
        const double distance = std::abs(kinematics.omega_rad_s - target_omega);
        if (selected_index < 0 || distance < selected_distance) {
            selected_index = index;
            selected_kr = kr;
            selected_ki = ki;
            selected_omega = omega;
            selected_imaginary = imaginary;
            selected_distance = distance;
        }
    }
    if (selected_index < 0) {
        out_diagnostics->reason = "dense_oracle_no_positive_frequency_candidate";
        destroy();
        return false;
    }
    if (EPSGetEigenpair(
            oracle_eps,
            selected_index,
            &selected_kr,
            &selected_ki,
            eigenvector_real,
            eigenvector_imag) != 0) {
        return fail("dense_oracle_selected_eigenvector_query_failed");
    }
    std::vector<Complex> split_eigenvector;
    std::vector<Complex> q;
    if (!copy_native_floquet_eigenvector(
            eigenvector_real,
            eigenvector_imag,
            q_split_count,
            split_eigenvector) ||
        (q = physical_complex_vector_from_split(
             split_eigenvector,
             operator_view.q_complex_dof_count)).size() !=
            static_cast<std::size_t>(operator_view.q_complex_dof_count) ||
        VecCreateSeq(PETSC_COMM_SELF, q_split_count, &physical_q) != 0 ||
        !set_real_split_vector_from_complex(physical_q, q)) {
        return fail("dense_oracle_selected_mode_reconstruction_failed");
    }
    if (MatMult(direct_a_phiq, physical_q, rhs_phi) != 0 ||
        VecScale(rhs_phi, static_cast<PetscScalar>(-1.0)) != 0 ||
        KSPSolve(oracle_p_ksp, rhs_phi, phi_solution) != 0) {
        return fail("dense_oracle_selected_poisson_solve_failed");
    }
    KSPConvergedReason selected_poisson_reason = KSP_CONVERGED_ITERATING;
    if (KSPGetConvergedReason(oracle_p_ksp, &selected_poisson_reason) != 0 ||
        selected_poisson_reason < 0) {
        return fail("dense_oracle_selected_poisson_not_converged");
    }
    std::vector<Complex> phi;
    if (!read_real_split_complex_vector(
            phi_solution,
            operator_view.phi_dof_count,
            phi)) {
        return fail("dense_oracle_selected_phi_reconstruction_failed");
    }
    PetscReal eps_residual = 0.0;
    if (EPSComputeError(
            oracle_eps,
            selected_index,
            EPS_ERROR_ABSOLUTE,
            &eps_residual) != 0) {
        return fail("dense_oracle_selected_eps_residual_failed");
    }
    const double raw_lambda_real =
        -static_cast<double>(context->phase_sign) * selected_imaginary;
    const double raw_lambda_imag =
        static_cast<double>(context->phase_sign) * selected_omega;
    const double projected_lambda_imag = raw_lambda_imag;
    const double magnetic_raw = floquet_magnetic_residual(
        operator_view,
        q,
        phi,
        Complex(raw_lambda_real, raw_lambda_imag));
    const double magnetic_projected = floquet_magnetic_residual(
        operator_view,
        q,
        phi,
        Complex(0.0, projected_lambda_imag));
    const double potential = floquet_potential_residual(operator_view, q, phi);
    const ModeKinematics projected_kinematics = map_eigenvalue(
        {0.0, projected_lambda_imag},
        spectral_request.phase_convention);
    const double split_norm = complex_vector_norm(split_eigenvector);
    const double q_norm = complex_vector_norm(q);
    if (!std::isfinite(static_cast<double>(eps_residual)) ||
        !std::isfinite(magnetic_raw) ||
        !std::isfinite(magnetic_projected) ||
        !std::isfinite(potential) ||
        !std::isfinite(projected_kinematics.frequency_hz) ||
        !std::isfinite(split_norm) || !std::isfinite(q_norm) ||
        !(q_norm > std::numeric_limits<double>::epsilon())) {
        return fail("dense_oracle_nonfinite_or_null_physical_mode");
    }
    out_diagnostics->candidate_found = true;
    out_diagnostics->reason = "";
    out_diagnostics->status = "ok";
    out_diagnostics->eps_absolute_residual = static_cast<double>(eps_residual);
    out_diagnostics->rotated_omega_rad_s = selected_omega;
    out_diagnostics->rotated_imaginary_rad_s = selected_imaginary;
    out_diagnostics->frequency_hz = projected_kinematics.frequency_hz;
    out_diagnostics->frequency_distance_hz = selected_distance /
        (2.0 * std::acos(-1.0));
    out_diagnostics->raw_lambda_real_per_s = raw_lambda_real;
    out_diagnostics->raw_lambda_imag_rad_per_s = raw_lambda_imag;
    out_diagnostics->projected_lambda_real_per_s = 0.0;
    out_diagnostics->projected_lambda_imag_rad_per_s = projected_lambda_imag;
    out_diagnostics->magnetic_residual_raw = magnetic_raw;
    out_diagnostics->magnetic_residual_projected = magnetic_projected;
    out_diagnostics->potential_residual = potential;
    out_diagnostics->q_projection_ratio = q_norm /
        std::max(split_norm, std::numeric_limits<double>::min());
    destroy();
    return true;
}

#endif

} // namespace

FloquetSharedDomainSparseModalSolveContext::FloquetSharedDomainSparseModalSolveContext() noexcept = default;

FloquetSharedDomainSparseModalSolveContext::
    ~FloquetSharedDomainSparseModalSolveContext() noexcept
{
#if FULLMAG_FEM_WITH_SLEPC
    destroy_opaque_floquet_window_context(opaque);
#endif
    opaque = nullptr;
}

FloquetModalSolverAdmission admit_floquet_modal_request(
    const ModalEigenRequest &request,
    const SLEPcTinyGyrotropicModalEigenRequest &spectral_request) noexcept
{
    FloquetModalSolverAdmission admission{};
    if (!frequency_window_is_valid(spectral_request, &admission.frequency_window)) {
        admission.reason = "floquet_modal_requires_valid_frequency_window";
        return admission;
    }
    admission.dynamic_demag_k = request.operator_request.include_demag != 0;
    if (request.execution_target == ModalExecutionTarget::production_gpu) {
        admission.reason = "floquet_modal_gpu_lane_not_owned_by_cpu_solver";
        return admission;
    }
    if (request.operator_request.spin_wave_bc_kind == nullptr ||
        std::strcmp(request.operator_request.spin_wave_bc_kind, "floquet") != 0) {
        admission.reason = "floquet_modal_requires_floquet_boundary";
        return admission;
    }
    if (!floquet_k_payload_is_consistent(request)) {
        admission.reason = "floquet_modal_k_vector_payload_mismatch";
        return admission;
    }
    if (!finite_nonzero_k(request)) {
        admission.reason = "floquet_modal_requires_finite_nonzero_three_vector";
        return admission;
    }
    admission.nonzero_k = true;
    if (request.floquet_periodic_pair_count == 0u ||
        request.floquet_periodic_pairs == nullptr) {
        admission.reason = "floquet_modal_requires_periodic_pair_payload";
        return admission;
    }
    if (!has_floquet_payload_marker(request)) {
        admission.reason = "floquet_modal_requires_bloch_floquet_operator_payload";
        return admission;
    }
    if (request.operator_request.include_demag != 0) {
        if (request.dynamic_demag_k_tangent_matrix_row_major == nullptr ||
            request.dynamic_demag_k_tangent_matrix_value_count == 0u) {
            admission.reason = "floquet_modal_requires_dynamic_demag_k_payload";
            return admission;
        }
        if (!dense_matrix_payload_is_valid(
                request.dynamic_demag_k_tangent_matrix_row_major,
                request.dynamic_demag_k_tangent_matrix_value_count,
                spectral_request.tangent_dof_count)) {
            admission.reason =
                "floquet_modal_requires_finite_square_dynamic_demag_k_payload";
            return admission;
        }
    }
    if (spectral_request.tangent_dof_count <= 0 ||
        spectral_request.stiffness_matrix_row_major == nullptr ||
        spectral_request.gyrotropic_matrix_row_major == nullptr) {
        admission.reason = "floquet_modal_requires_realified_spectral_operator";
        return admission;
    }
    admission.accepted = true;
    admission.reason = "accepted_floquet_cpu_slepc";
    return admission;
}

FloquetModalSolverAdmission admit_floquet_modal_sparse_request(
    const ModalEigenRequest &request,
    const SLEPcSparseGyrotropicModalEigenRequest &spectral_request) noexcept
{
    FloquetModalSolverAdmission admission{};
    if (!frequency_window_is_valid(spectral_request, &admission.frequency_window)) {
        admission.reason = "floquet_modal_requires_valid_frequency_window";
        return admission;
    }
    if (request.execution_target == ModalExecutionTarget::production_gpu) {
        admission.reason = "floquet_modal_gpu_lane_not_owned_by_cpu_solver";
        return admission;
    }
    if (request.operator_request.spin_wave_bc_kind == nullptr ||
        std::strcmp(request.operator_request.spin_wave_bc_kind, "floquet") != 0) {
        admission.reason = "floquet_modal_requires_floquet_boundary";
        return admission;
    }
    if (!floquet_k_payload_is_consistent(request)) {
        admission.reason = "floquet_modal_k_vector_payload_mismatch";
        return admission;
    }
    if (!finite_nonzero_k(request)) {
        admission.reason = "floquet_modal_requires_finite_nonzero_three_vector";
        return admission;
    }
    admission.nonzero_k = true;
    if (request.floquet_periodic_pair_count == 0u ||
        request.floquet_periodic_pairs == nullptr) {
        admission.reason = "floquet_modal_requires_periodic_pair_payload";
        return admission;
    }
    if (!has_floquet_payload_marker(request)) {
        admission.reason = "floquet_modal_requires_bloch_floquet_operator_payload";
        return admission;
    }
    if (request.operator_request.include_demag != 0) {
        admission.dynamic_demag_k = true;
        if (spectral_request.floquet_shared_domain_operator == nullptr) {
            admission.reason =
                "floquet_sparse_modal_requires_shared_domain_sparse_owner";
            return admission;
        }
    }
    if (spectral_request.tangent_dof_count <= 0) {
        admission.reason = "floquet_modal_requires_realified_sparse_operator";
        return admission;
    }
    if (spectral_request.floquet_shared_domain_operator != nullptr) {
        admission.reason = floquet_shared_operator_invalid_reason(
            spectral_request.floquet_shared_domain_operator,
            spectral_request.tangent_dof_count);
        if (admission.reason != nullptr) {
            return admission;
        }
    } else if (!sparse_view_is_valid(spectral_request.stiffness_csr) ||
               !sparse_view_is_valid(spectral_request.gyrotropic_csr) ||
               spectral_request.stiffness_csr.row_count !=
                   static_cast<std::uint64_t>(spectral_request.tangent_dof_count) ||
               spectral_request.gyrotropic_csr.row_count !=
                   static_cast<std::uint64_t>(spectral_request.tangent_dof_count)) {
            admission.reason = "floquet_modal_requires_realified_sparse_operator";
            return admission;
    }
    admission.accepted = true;
    admission.reason = "accepted_floquet_cpu_sparse_slepc";
    return admission;
}

SLEPcTinyGyrotropicModalEigenResult solve_floquet_modal_spectrum(
    const ModalEigenRequest &request,
    const SLEPcTinyGyrotropicModalEigenRequest &spectral_request) noexcept
{
    const FloquetModalSolverAdmission admission =
        admit_floquet_modal_request(request, spectral_request);
    if (!admission.accepted) {
        return validation_failure(admission.reason);
    }
    return solve_slepc_tiny_gyrotropic_modal_eigen(spectral_request);
}

SLEPcTinyGyrotropicModalEigenResult solve_floquet_modal_sparse_spectrum(
    const ModalEigenRequest &request,
    const SLEPcSparseGyrotropicModalEigenRequest &spectral_request) noexcept
{
    const FloquetModalSolverAdmission admission =
        admit_floquet_modal_sparse_request(request, spectral_request);
    if (!admission.accepted) {
        return validation_failure(admission.reason);
    }
    if (spectral_request.floquet_shared_domain_operator != nullptr) {
        return solve_floquet_shared_domain_sparse_modal_spectrum(
            *spectral_request.floquet_shared_domain_operator,
            spectral_request);
    }
    return solve_slepc_sparse_gyrotropic_modal_eigen(spectral_request);
}

SLEPcTinyGyrotropicModalEigenResult
solve_floquet_shared_domain_sparse_modal_spectrum(
    const FloquetSharedDomainSparseModalOperator &operator_view,
    const SLEPcSparseGyrotropicModalEigenRequest &spectral_request) noexcept
{
    return solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context(
        operator_view,
        spectral_request,
        nullptr);
}

SLEPcTinyGyrotropicModalEigenResult
solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context(
    const FloquetSharedDomainSparseModalOperator &operator_view,
    const SLEPcSparseGyrotropicModalEigenRequest &spectral_request,
    FloquetSharedDomainSparseModalSolveContext *reuse_context) noexcept
{
    SLEPcTinyGyrotropicModalEigenResult result{};
    // Seed the opt-in diagnostic before any shared-operator validation or
    // PETSc/SLEPc setup. Every early return must distinguish an enabled but
    // unreachable probe from the environment-disabled null field.
    initialize_floquet_schur_action_diagnostic(&result);
    result.solver_adapter = "floquet_airbox_cpu_schur_slepc";
    result.eps_type = "krylovschur";
    result.problem_type = "gnhep";
    result.spectral_transform = "shift_invert";
    result.which_eigenpairs = "target_magnitude";
    result.ksp_type = "gmres";
    result.ksp_orthogonalization = "classical_gram_schmidt_refine_always";
    result.ksp_breakdown_tolerance =
        static_cast<double>(kFloquetShiftedGmresBreakdownTolerance);
    result.pc_type = "lu";
    result.factorization_package = "petsc_default_lu";
    result.factorization_shift_policy = "pending_preconditioner_norm";
    result.poisson_ksp_type = "preonly";
    result.poisson_pc_type = "lu";
    result.poisson_factorization_package = "petsc_default_lu";
    result.poisson_factorization_shift_policy = "MAT_SHIFT_NONE";
    result.poisson_iteration_semantics =
        "preonly_factorization_no_iterative_convergence";
    result.nullspace_policy = "nonzero_k_invertible_poisson";
    result.unsupported_reason = "";
    const double not_measured = std::numeric_limits<double>::quiet_NaN();
    result.ksp_final_residual = not_measured;
    result.max_candidate_relative_residual = not_measured;
    result.eps_normalized_absolute_tolerance = not_measured;
    result.max_eps_normalized_absolute_residual = not_measured;
    result.max_floquet_magnetic_relative_residual = not_measured;
    result.max_floquet_potential_relative_residual = not_measured;

    const int advertised_dimension = spectral_request.tangent_dof_count;
    const char *operator_invalid_reason =
        floquet_shared_operator_invalid_reason(&operator_view, advertised_dimension);
    if (operator_invalid_reason != nullptr) {
        result.status = "validation_error";
        result.unsupported_reason = operator_invalid_reason;
        return result;
    }

#if !FULLMAG_FEM_WITH_SLEPC
    (void)operator_view;
    (void)spectral_request;
    result.unsupported_reason = "slepc_not_available";
    return result;
#elif defined(PETSC_USE_COMPLEX)
    (void)operator_view;
    (void)spectral_request;
    result.unsupported_reason = "floquet_shared_domain_requires_real_petsc_split";
    return result;
#else
    const std::lock_guard<std::mutex> lock(native_floquet_solver_mutex());

    PetscBool slepc_initialized = PETSC_FALSE;
    if (SlepcInitialized(&slepc_initialized) != 0 ||
        (!slepc_initialized && SlepcInitializeNoArguments() != 0)) {
        result.status = "solve_error";
        result.unsupported_reason = "slepc_initialization_failed";
        return result;
    }

    const bool borrowed_reuse_state = reuse_context != nullptr;
    ReusableFloquetWindowStateOwner local_state_owner;
    ReusableFloquetWindowState *state = nullptr;
    if (!borrowed_reuse_state) {
        local_state_owner.reset(new (std::nothrow) ReusableFloquetWindowState{});
        if (!local_state_owner) {
            result.status = "solve_error";
            result.unsupported_reason = "floquet_local_state_allocation_failed";
            return result;
        }
        state = local_state_owner.get();
    }
    const int requested_phase_sign = spectral_request.phase_convention ==
        FrequencyDomainPhaseConvention::exp_i_omega_t ? 1 : -1;
    const auto reuse_text_matches = [](const char *left, const char *right) noexcept {
        if (left == nullptr || right == nullptr) {
            return left == right;
        }
        return std::strcmp(left, right) == 0;
    };
    if (reuse_context != nullptr) {
        if (reuse_context->opaque == nullptr) {
            auto *created = new (std::nothrow) ReusableFloquetWindowState{};
            if (created == nullptr) {
                result.status = "solve_error";
                result.unsupported_reason = "floquet_reuse_context_allocation_failed";
                return result;
            }
            reuse_context->opaque = created;
        }
        state = static_cast<ReusableFloquetWindowState *>(reuse_context->opaque);
        if (state->invalidated) {
            result.status = "solve_error";
            result.unsupported_reason = "floquet_reuse_context_invalidated";
            return result;
        }
        if (state->initialized &&
            (state->operator_identity != &operator_view ||
             state->phase_sign != requested_phase_sign ||
             state->context.q_complex_count != static_cast<PetscInt>(
                 operator_view.q_complex_dof_count) ||
             state->context.q_split_count != static_cast<PetscInt>(
                 2u * operator_view.q_complex_dof_count) ||
             state->context.phi_split_count != static_cast<PetscInt>(
                 2u * operator_view.phi_dof_count) ||
             !reuse_text_matches(state->boundary_kind, operator_view.boundary_kind) ||
             !reuse_text_matches(state->gauge_policy, operator_view.gauge_policy) ||
             state->k_rad_per_m != operator_view.k_rad_per_m ||
             state->mu0_T_m_A != operator_view.mu0_T_m_A ||
             state->residual_tolerance != spectral_request.residual_tolerance ||
             state->max_linear_iterations != spectral_request.max_linear_iterations)) {
            result.status = "validation_error";
            result.unsupported_reason = "floquet_reuse_context_mismatch";
            return result;
        }
    }
    NativeFloquetMatShellContext &context = state->context;
    Mat &shell = state->shell;
    Mat &gyrotropic = state->gyrotropic;
    // Error text belongs to one attempt; a later subwindow must not inherit a
    // diagnostic from a previous shift that reused the same MatShell.
    context.error_message[0] = '\0';
    Mat shifted_preconditioner = nullptr;
    bool exact_schur_preconditioner_materialized = false;
    EPS eps = nullptr;
    bool eps_cleanup_is_safe = true;
    Vec xr = nullptr;
    Vec xi = nullptr;
    LastFloquetShiftedSolveSnapshot last_shifted_solve{};
    std::unique_ptr<detail::FloquetShiftedKspTrueConvergenceContext>
        shifted_ksp_true_convergence_context{};
    bool shifted_ksp_true_convergence_test_registration_attempted = false;
    auto destroy_all = [&]() noexcept {
        if (last_shifted_solve.rhs != nullptr) {
            VecDestroy(&last_shifted_solve.rhs);
        }
        if (last_shifted_solve.solution != nullptr) {
            VecDestroy(&last_shifted_solve.solution);
        }
        if (last_shifted_solve.true_residual != nullptr) {
            VecDestroy(&last_shifted_solve.true_residual);
        }
        if (xr != nullptr) {
            VecDestroy(&xr);
        }
        if (xi != nullptr) {
            VecDestroy(&xi);
        }
        PetscErrorCode eps_destroy_error = 0;
        if (eps != nullptr && eps_cleanup_is_safe) {
            eps_destroy_error = EPSDestroy(&eps);
        }
        if (shifted_ksp_true_convergence_context != nullptr) {
            if ((!eps_cleanup_is_safe ||
                 (eps_destroy_error != 0 && eps != nullptr)) &&
                shifted_ksp_true_convergence_test_registration_attempted) {
                (void)shifted_ksp_true_convergence_context.release();
            } else {
                (void)detail::clear_floquet_shifted_ksp_true_convergence_context(
                    shifted_ksp_true_convergence_context.get());
            }
        }
        if (last_shifted_solve.shifted_operator != nullptr) {
            MatDestroy(&last_shifted_solve.shifted_operator);
        }
        if (shifted_preconditioner != nullptr) {
            MatDestroy(&shifted_preconditioner);
        }
        // Heap-owned nonreuse state is released by local_state_owner.  A
        // borrowed window state belongs to FloquetSharedDomainSparseModal-
        // SolveContext and remains available for the next subwindow.
    };

    const PetscReal target_shift = static_cast<PetscReal>(
        omega_rad_s_from_frequency_hz(
            std::max(0.0, spectral_request.target_frequency_hz)));
    // Both fresh Poisson setup and every shifted solve use the request policy.
    const PetscInt requested_linear_iterations =
        spectral_request.max_linear_iterations > 0
            ? static_cast<PetscInt>(spectral_request.max_linear_iterations)
            : PETSC_DEFAULT;
    if (!state->initialized) {
        context.phase_sign = requested_phase_sign;
        context.q_complex_count = static_cast<PetscInt>(
            operator_view.q_complex_dof_count);
        context.q_split_count = static_cast<PetscInt>(
            2u * operator_view.q_complex_dof_count);
        context.phi_split_count = static_cast<PetscInt>(
            2u * operator_view.phi_dof_count);
        if (!create_real_split_matrix(*operator_view.a_qq, &context.a_qq) ||
            !create_real_split_matrix(
                *operator_view.a_qq,
                &context.rotated_a_qq,
                context.phase_sign) ||
            !create_real_split_matrix(*operator_view.a_qphi, &context.a_qphi) ||
            !create_real_split_matrix(*operator_view.a_phiq, &context.a_phiq) ||
            !create_real_split_matrix(*operator_view.p, &context.p) ||
            !create_real_split_matrix(*operator_view.b_qq, &gyrotropic)) {
            result.status = "solve_error";
            result.unsupported_reason =
                "petsc_floquet_sparse_matrix_creation_failed";
            destroy_reusable_floquet_window_state(state);
            destroy_all();
            return result;
        }
        if (KSPCreate(PETSC_COMM_SELF, &context.p_ksp) != 0 ||
            KSPSetOperators(context.p_ksp, context.p, context.p) != 0 ||
            KSPSetType(context.p_ksp, KSPPREONLY) != 0) {
            result.status = "solve_error";
            result.unsupported_reason = "floquet_poisson_ksp_creation_failed";
            destroy_reusable_floquet_window_state(state);
            destroy_all();
            return result;
        }
        const PetscReal poisson_ksp_rtol = std::max(
        static_cast<PetscReal>(1.0e-13),
        std::min(
            static_cast<PetscReal>(1.0e-10),
            static_cast<PetscReal>(1.0e-3 * std::max(
                spectral_request.residual_tolerance,
                1.0e-10))));
        // Keep both KSP layers explicit.  PETSC_DEFAULT is part of the selected
        // PETSc policy here; query the resolved value below instead of reporting
        // a guessed zero or introducing a hidden absolute-tolerance constant.
        PC poisson_pc = nullptr;
        // This preonly LU computes P(k)^-1 inside the physical Schur operator.
        // A factorization shift would change that inverse, so an unusable P(k)
        // must fail closed instead of regularizing the physical Poisson block.
        if (KSPGetPC(context.p_ksp, &poisson_pc) != 0 ||
        PCSetType(poisson_pc, PCLU) != 0 ||
        PCFactorSetShiftType(poisson_pc, MAT_SHIFT_NONE) != 0 ||
        KSPSetTolerances(
            context.p_ksp,
            poisson_ksp_rtol,
            PETSC_DEFAULT,
            PETSC_DEFAULT,
            requested_linear_iterations) != 0 ||
        KSPSetErrorIfNotConverged(context.p_ksp, PETSC_TRUE) != 0 ||
        KSPSetUp(context.p_ksp) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, context.phi_split_count, &context.phi_rhs) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, context.phi_split_count, &context.phi_solution) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, context.q_split_count, &context.feedback) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, context.q_split_count, &context.q_physical_real) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, context.q_split_count, &context.q_physical_imag) != 0) {
            result.status = "solve_error";
            result.unsupported_reason = "floquet_poisson_ksp_setup_failed";
            destroy_reusable_floquet_window_state(state);
            destroy_all();
            return result;
        }
        PetscReal poisson_actual_rtol = 0.0;
        PetscReal poisson_actual_atol = 0.0;
        PetscReal poisson_actual_dtol = 0.0;
        PetscInt poisson_actual_max_iterations = 0;
        if (KSPGetTolerances(
            context.p_ksp,
            &poisson_actual_rtol,
            &poisson_actual_atol,
            &poisson_actual_dtol,
            &poisson_actual_max_iterations) != 0) {
            result.status = "solve_error";
            result.unsupported_reason = "floquet_poisson_ksp_tolerance_query_failed";
            destroy_reusable_floquet_window_state(state);
            destroy_all();
            return result;
        }
        (void)poisson_actual_dtol;
        state->poisson_ksp_rtol = static_cast<double>(poisson_actual_rtol);
        state->poisson_ksp_atol = static_cast<double>(poisson_actual_atol);
        state->poisson_ksp_max_iterations = poisson_actual_max_iterations > 0
            ? static_cast<int>(poisson_actual_max_iterations)
            : 0;
        result.poisson_ksp_rtol = state->poisson_ksp_rtol;
        result.poisson_ksp_atol = state->poisson_ksp_atol;
        result.poisson_ksp_max_iterations = state->poisson_ksp_max_iterations;
        if (operator_view.uniform_transverse_probe_q_y != nullptr ||
        operator_view.uniform_transverse_probe_q_z != nullptr) {
            if (!run_floquet_demag_operator_probe(
                &context,
                operator_view,
                &state->demag_probe)) {
                result.status = "solve_error";
                result.unsupported_reason = "floquet_dynamic_demag_operator_probe_failed";
                destroy_reusable_floquet_window_state(state);
                destroy_all();
                return result;
            }
            state->demag_probe_completed = true;
            result.dynamic_demag_operator_probe = state->demag_probe;
        }
        if (MatCreateShell(
            PETSC_COMM_SELF,
            context.q_split_count,
            context.q_split_count,
            context.q_split_count,
            context.q_split_count,
            &context,
            &shell) != 0 ||
        MatShellSetOperation(
            shell,
            MATOP_MULT,
            reinterpret_cast<void (*)(void)>(native_floquet_matmult)) != 0) {
            result.status = "solve_error";
            result.unsupported_reason = "floquet_matshell_creation_failed";
            destroy_reusable_floquet_window_state(state);
            destroy_all();
            return result;
        }
        state->operator_identity = &operator_view;
        state->boundary_kind = operator_view.boundary_kind;
        state->gauge_policy = operator_view.gauge_policy;
        state->k_rad_per_m = operator_view.k_rad_per_m;
        state->mu0_T_m_A = operator_view.mu0_T_m_A;
        state->phase_sign = requested_phase_sign;
        state->residual_tolerance = spectral_request.residual_tolerance;
        state->max_linear_iterations = spectral_request.max_linear_iterations;
        state->applied_normalization_scale = 1.0;
        state->initialized = true;
    }
    if (state->demag_probe_completed) {
        result.dynamic_demag_operator_probe = state->demag_probe;
    }
    result.poisson_ksp_rtol = state->poisson_ksp_rtol;
    result.poisson_ksp_atol = state->poisson_ksp_atol;
    result.poisson_ksp_max_iterations = state->poisson_ksp_max_iterations;
    if (!normalize_native_floquet_pencil(
            &context,
            gyrotropic,
            target_shift,
            state->applied_normalization_scale,
            &result.operator_normalization_scale)) {
        result.status = "solve_error";
        result.unsupported_reason = "floquet_operator_normalization_failed";
        // MatScale can fail after modifying only a prefix of the pencil.  The
        // borrowed context must therefore be discarded rather than reused
        // with matrices whose relative scale is no longer known.
        destroy_reusable_floquet_window_state(state);
        destroy_all();
        return result;
    }
    state->applied_normalization_scale = result.operator_normalization_scale;
    if (floquet_dense_oracle_requested()) {
        // C2 is explicitly diagnostic.  Its failure must never change the
        // production Schur/Krylov path or introduce a fallback solver.
        (void)run_floquet_dense_original_oracle(
            &context,
            shell,
            operator_view,
            spectral_request,
            result.operator_normalization_scale,
            &result.floquet_dense_oracle);
    }
    if (EPSCreate(PETSC_COMM_SELF, &eps) != 0 ||
        EPSSetOperators(eps, shell, gyrotropic) != 0 ||
        EPSSetProblemType(eps, EPS_GNHEP) != 0 ||
        EPSSetType(eps, EPSKRYLOVSCHUR) != 0) {
        result.status = "solve_error";
        result.unsupported_reason = "floquet_slepc_configuration_failed";
        destroy_all();
        return result;
    }
    const PetscInt split_dimension = context.q_split_count;
    const PetscInt requested_pairs = std::max<PetscInt>(
        1,
        static_cast<PetscInt>(std::max(1, spectral_request.requested_mode_count) * 2));
    const PetscInt nev = std::min<PetscInt>(
        std::max<PetscInt>(1, split_dimension - 1), requested_pairs);
    // The default Krylov subspace can be too narrow for the clustered
    // interior spectrum produced by the Floquet Schur pencil. Use a bounded
    // 32-vector floor for the current small-mode path, while preserving the
    // usual >= 2*nev relation and never exceeding the operator dimension.
    // This is a solver-convergence experiment; original-pencil residual gates
    // remain unchanged and decide physical acceptance.
    const PetscInt doubled_nev = nev > split_dimension / 2
        ? split_dimension
        : static_cast<PetscInt>(2 * nev);
    const PetscInt ncv = std::min<PetscInt>(
        split_dimension, std::max<PetscInt>(32, doubled_nev));
    ST spectral_transform = nullptr;
    KSP shifted_ksp = nullptr;
    PC shifted_pc = nullptr;
    const PetscReal eigen_tolerance = static_cast<PetscReal>(
        spectral_request.residual_tolerance > 0.0
            ? spectral_request.residual_tolerance
            : 1.0e-10);
    // The generalized pencil has been normalized by its global operator
    // scale, while the physical acceptance gate uses a per-mode backward
    // residual formed from the magnetic and demag blocks. Those scales can
    // differ substantially when airbox modes dominate the global norm. Use a
    // conservative 1e-3 safety factor for EPS's absolute true-residual
    // prefilter; the independent original-block residual below remains the
    // only physical acceptance gate. EPS_ERROR_RELATIVE divides by |lambda|
    // and is not a dimensionless residual for this SI-valued pencil.
    const PetscReal default_eps_absolute_tolerance = std::max(
        static_cast<PetscReal>(100.0 * PETSC_MACHINE_EPSILON),
        static_cast<PetscReal>(kFloquetEpsTrueResidualSafetyFactor) *
            eigen_tolerance);
    const PetscReal default_shifted_ksp_tolerance = std::max(
        static_cast<PetscReal>(1.0e-13),
        std::min(static_cast<PetscReal>(1.0e-8),
                 static_cast<PetscReal>(1.0e-3 * eigen_tolerance)));
    const ModalKrylovTuning default_tuning{
        static_cast<double>(default_eps_absolute_tolerance),
        static_cast<double>(default_shifted_ksp_tolerance),
        static_cast<int>(kFloquetShiftedGmresDefaultRestart),
        "gmres"};
    ModalKrylovTuning resolved_tuning{};
    if (!resolve_modal_krylov_tuning(default_tuning, true, &resolved_tuning)) {
        result.status = "validation_error";
        result.unsupported_reason = "floquet_diagnostic_ksp_option_invalid";
        destroy_all();
        return result;
    }
    const PetscReal eps_absolute_tolerance =
        static_cast<PetscReal>(resolved_tuning.eps_prefilter_abs);
    const PetscReal shifted_ksp_tolerance =
        static_cast<PetscReal>(resolved_tuning.shifted_ksp_rtol);
    const char *requested_shifted_ksp_type = resolved_tuning.shifted_ksp_type;
    const PetscInt requested_gmres_restart =
        static_cast<PetscInt>(resolved_tuning.gmres_restart);
    result.ksp_type = requested_shifted_ksp_type;
    if (std::strcmp(requested_shifted_ksp_type, KSPFGMRES) == 0) {
        // FGMRES does not use the GMRES residual-gap breakdown control.
        result.ksp_breakdown_tolerance =
            std::numeric_limits<double>::quiet_NaN();
    }
    result.eps_normalized_absolute_tolerance =
        static_cast<double>(eps_absolute_tolerance);
    const PetscInt max_outer = spectral_request.max_outer_iterations > 0
        ? static_cast<PetscInt>(spectral_request.max_outer_iterations)
        : PETSC_DEFAULT;
    if (EPSSetDimensions(eps, nev, ncv, PETSC_DEFAULT) != 0 ||
        EPSSetWhichEigenpairs(eps, EPS_TARGET_MAGNITUDE) != 0 ||
        EPSSetTarget(eps, static_cast<PetscScalar>(target_shift)) != 0 ||
        EPSSetTrueResidual(eps, PETSC_TRUE) != 0 ||
        EPSSetConvergenceTest(eps, EPS_CONV_ABS) != 0 ||
        EPSMonitorSet(eps, monitor_native_floquet_eps, &result, nullptr) != 0 ||
        EPSSetTolerances(eps, eps_absolute_tolerance, max_outer) != 0 ||
        EPSGetST(eps, &spectral_transform) != 0 ||
        STSetType(spectral_transform, STSINVERT) != 0 ||
        // Keep the generalized shift-invert action matrix-free.  With the
        // default COPY mode PETSc tries to materialize shell - sigma*B;
        // the explicit rotated magnetic block below is only its safe
        // preconditioner and must not become the eigensolver operator.
        STSetMatMode(spectral_transform, ST_MATMODE_SHELL) != 0 ||
        STSetShift(spectral_transform, static_cast<PetscScalar>(target_shift)) != 0 ||
        !create_native_floquet_shifted_preconditioner(
            shell,
            context.rotated_a_qq,
            gyrotropic,
            static_cast<PetscScalar>(target_shift),
            &shifted_preconditioner,
            &result.preconditioner_normalization_scale,
            &exact_schur_preconditioner_materialized)) {
        result.status = "solve_error";
        result.unsupported_reason = "floquet_slepc_configuration_failed";
        destroy_all();
        return result;
    }
    PetscReal shifted_preconditioner_norm = 0.0;
    if (MatNorm(shifted_preconditioner, NORM_INFINITY,
                &shifted_preconditioner_norm) != 0 ||
        !std::isfinite(static_cast<double>(shifted_preconditioner_norm)) ||
        shifted_preconditioner_norm <= 0.0) {
        result.status = "solve_error";
        result.unsupported_reason = "floquet_shifted_preconditioner_norm_failed";
        destroy_all();
        return result;
    }
    // This shift regularizes only the LU factorization used as a
    // preconditioner for the exact matrix-free Schur shift-invert action. The
    // preconditioner is norm-scaled above; sqrt(machine epsilon) times its
    // measured norm is large enough to clear PETSc's zero-pivot threshold but
    // remains a small relative perturbation. EPS/KSP still applies the exact
    // shell operator and accepted modes must pass the original-pencil residual.
    const PetscReal factorization_shift_amount =
        std::sqrt(static_cast<PetscReal>(PETSC_MACHINE_EPSILON)) *
        shifted_preconditioner_norm;
    if (!std::isfinite(static_cast<double>(factorization_shift_amount)) ||
        factorization_shift_amount <= 0.0) {
        result.status = "solve_error";
        result.unsupported_reason = "floquet_factorization_shift_invalid";
        destroy_all();
        return result;
    }
    result.factorization_shift_policy = exact_schur_preconditioner_materialized
        ? "exact_schur_materialized_MAT_SHIFT_NONZERO_sqrt_machine_epsilon_times_norm"
        : "magnetic_only_MAT_SHIFT_NONZERO_sqrt_machine_epsilon_times_norm";
    result.factorization_shift_amount =
        static_cast<double>(factorization_shift_amount);
    // The explicit magnetic shifted pencil remains a preconditioner only; the
    // shell is the eigensolver operator. A Jacobi diagonal is invalid here
    // because the real-frequency rotation puts magnetic and gyrotropic terms
    // in off-diagonal real-split slots.
    if (
        STSetPreconditionerMat(spectral_transform, shifted_preconditioner) != 0 ||
        STGetKSP(spectral_transform, &shifted_ksp) != 0 ||
        KSPSetType(shifted_ksp, requested_shifted_ksp_type) != 0 ||
        KSPGMRESSetRestart(shifted_ksp, requested_gmres_restart) != 0 ||
        // The Schur MatShell applies Poisson through PREONLY/LU. Roundoff
        // can make the recursive GMRES norm drift from the explicitly
        // recomputed norm at restart. Permit residual replacement while the
        // rebuilt norm stays within twice the norm at the beginning of the
        // cycle. PETSc still reports larger discrepancies and all actual
        // nonconvergence as hard errors; the independent true-residual and
        // original-pencil gates below remain authoritative.
        (std::strcmp(requested_shifted_ksp_type, KSPGMRES) == 0 &&
         KSPGMRESSetBreakdownTolerance(
             shifted_ksp,
             kFloquetShiftedGmresBreakdownTolerance) != 0) ||
        // The CGS refinement pilot did not clear the physical mode gate.
        // The restart option tests whether recomputing the residual before
        // projected convergence improves the true shifted-solve residual.
        KSPGMRESSetOrthogonalization(
            shifted_ksp,
            KSPGMRESClassicalGramSchmidtOrthogonalization) != 0 ||
        KSPGMRESSetCGSRefinementType(
            shifted_ksp,
            KSP_GMRES_CGS_REFINE_ALWAYS) != 0 ||
        // A left-preconditioned norm can be tiny even when the original
        // shifted Schur equation has a large residual.  Right GMRES measures
        // the unpreconditioned equation; physical mode acceptance still uses
        // the independently reconstructed original block residuals.
        KSPSetPCSide(shifted_ksp, PC_RIGHT) != 0 ||
        KSPSetNormType(shifted_ksp, KSP_NORM_UNPRECONDITIONED) != 0 ||
        KSPGetPC(shifted_ksp, &shifted_pc) != 0 ||
        PCSetType(shifted_pc, PCLU) != 0 ||
        PCFactorReorderForNonzeroDiagonal(shifted_pc, 1.0e-12) != 0 ||
        PCFactorSetShiftType(shifted_pc, MAT_SHIFT_NONZERO) != 0 ||
        PCFactorSetShiftAmount(shifted_pc, factorization_shift_amount) != 0 ||
        KSPSetTolerances(
            shifted_ksp,
            shifted_ksp_tolerance,
            PETSC_DEFAULT,
            PETSC_DEFAULT,
            requested_linear_iterations) != 0 ||
        KSPSetPostSolve(
            shifted_ksp,
            capture_last_floquet_shifted_solve,
            &last_shifted_solve) != 0 ||
        KSPSetErrorIfNotConverged(shifted_ksp, PETSC_TRUE) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, split_dimension, &xr) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, split_dimension, &xi) != 0) {
        result.status = "solve_error";
        result.unsupported_reason = "floquet_slepc_configuration_failed";
        destroy_all();
        return result;
    }
    const char *resolved_shifted_ksp_type = nullptr;
    if (KSPGetType(shifted_ksp, &resolved_shifted_ksp_type) != 0 ||
        resolved_shifted_ksp_type == nullptr ||
        std::strcmp(resolved_shifted_ksp_type, requested_shifted_ksp_type) != 0) {
        result.status = "solve_error";
        result.unsupported_reason = "floquet_shifted_ksp_type_mismatch";
        destroy_all();
        return result;
    }
    result.ksp_type = requested_shifted_ksp_type; // Static token survives EPS teardown.
    PetscReal shifted_actual_rtol = 0.0;
    PetscReal shifted_actual_atol = 0.0;
    PetscReal shifted_actual_dtol = 0.0;
    PetscInt shifted_actual_max_iterations = 0;
    PetscInt shifted_actual_gmres_restart = 0;
    if (KSPGetTolerances(
            shifted_ksp,
            &shifted_actual_rtol,
            &shifted_actual_atol,
            &shifted_actual_dtol,
            &shifted_actual_max_iterations) != 0 ||
        KSPGMRESGetRestart(shifted_ksp,
                           &shifted_actual_gmres_restart) != 0 ||
        shifted_actual_gmres_restart != requested_gmres_restart) {
        result.status = "solve_error";
        result.unsupported_reason = "floquet_shifted_ksp_tolerance_query_failed";
        destroy_all();
        return result;
    }
    (void)shifted_actual_dtol;
    result.ksp_rtol = static_cast<double>(shifted_actual_rtol);
    result.ksp_restart = static_cast<int>(shifted_actual_gmres_restart);
    result.ksp_atol = static_cast<double>(shifted_actual_atol);
    last_shifted_solve.expected_rtol = shifted_actual_rtol;
    last_shifted_solve.expected_atol = shifted_actual_atol;
    result.ksp_max_iterations = shifted_actual_max_iterations > 0
        ? static_cast<int>(shifted_actual_max_iterations)
        : 0;

    // Copy configuration while ST/KSP are safe to inspect. A hard EPS error
    // can leave borrowed DS views alive, so failure reporting must not query
    // those objects. This is pre-setup configuration, not convergence proof.
    PCSide configured_pc_side = PC_SIDE_DEFAULT;
    KSPNormType configured_norm_type = KSP_NORM_DEFAULT;
    if (KSPGetPCSide(shifted_ksp, &configured_pc_side) == 0 &&
        KSPGetNormType(shifted_ksp, &configured_norm_type) == 0) {
        result.shifted_ksp_configuration_before_eps_available = true;
        result.shifted_ksp_pc_side_before_eps = static_cast<int>(configured_pc_side);
        result.shifted_ksp_norm_type_before_eps = static_cast<int>(configured_norm_type);
    }

    // Optional action-only observation is completed before EPSSolve. It owns
    // bounded scratch vectors and never writes the production MatShell error
    // buffer, demag certificate, or solver tolerances. Its status is
    // diagnostic evidence only; it cannot qualify the physical operator.
    (void)run_floquet_schur_action_diagnostic(
        &context,
        result.operator_normalization_scale,
        result.preconditioner_normalization_scale,
        &result.floquet_schur_action_diagnostic);

    // Configure the ST operator before allocating callback work vectors. This
    // makes the workspaces match the actual shifted system, not its
    // preconditioner approximation.
    if (EPSSetUp(eps) != 0) {
        result.status = "solve_error";
        result.unsupported_reason = "floquet_slepc_setup_failed";
        state->invalidated = true;
        state->eps_lifetime_unsafe = true;
        eps_cleanup_is_safe = false;
        return result;
    }
    const char *resolved_shifted_ksp_type_after_setup = nullptr;
    if (KSPGetType(shifted_ksp, &resolved_shifted_ksp_type_after_setup) != 0 ||
        resolved_shifted_ksp_type_after_setup == nullptr ||
        std::strcmp(
            resolved_shifted_ksp_type_after_setup,
            requested_shifted_ksp_type) != 0) {
        result.status = "solve_error";
        result.unsupported_reason = "floquet_shifted_ksp_type_mismatch_after_setup";
        destroy_all();
        return result;
    }
    detail::FloquetShiftedKspTrueConvergenceContext *raw_true_convergence_context =
        nullptr;
    if (detail::create_floquet_shifted_ksp_true_convergence_context(
            shifted_ksp, &raw_true_convergence_context) != 0 ||
        raw_true_convergence_context == nullptr) {
        result.status = "solve_error";
        result.unsupported_reason =
            "floquet_shifted_true_convergence_setup_failed";
        destroy_all();
        return result;
    }
    shifted_ksp_true_convergence_context.reset(raw_true_convergence_context);
    if (shifted_ksp_true_convergence_context->rtol != shifted_actual_rtol ||
        shifted_ksp_true_convergence_context->atol != shifted_actual_atol ||
        shifted_ksp_true_convergence_context->max_iterations !=
            shifted_actual_max_iterations) {
        result.status = "solve_error";
        result.unsupported_reason =
            "floquet_shifted_ksp_tolerances_changed_during_setup";
        destroy_all();
        return result;
    }
    shifted_ksp_true_convergence_test_registration_attempted = true;
    if (KSPSetConvergenceTest(
            shifted_ksp,
            detail::floquet_shifted_true_convergence_test,
            shifted_ksp_true_convergence_context.get(),
            detail::destroy_floquet_shifted_ksp_true_convergence_context) != 0) {
        result.status = "solve_error";
        result.unsupported_reason =
            "floquet_shifted_true_convergence_registration_failed";
        destroy_all();
        return result;
    }

    // Monitor data is copied during KSP iterations, before a hard EPSSolve
    // error can unwind through PETSc. Registration failure is diagnostic-only.
    last_shifted_solve.monitor_registered =
        KSPMonitorSet(
            shifted_ksp,
            capture_floquet_shifted_ksp_progress,
            &last_shifted_solve,
            nullptr) == 0;
    const PetscErrorCode eps_solve_error = EPSSolve(eps);
    // A KSP error can unwind through Krylov--Schur while SLEPc owns a
    // DSGetMat() view.  SLEPc 3.24 then cannot safely destroy that EPS because
    // DSReset() attempts to destroy the still-borrowed dense parent.  Keep the
    // first error authoritative and leave this one process-bounded EPS object
    // for OS reclamation; the runtime fails closed immediately afterwards.
    eps_cleanup_is_safe = eps_solve_error == 0;
    // Copy only ordinary cached values here. In particular, a hard error
    // below must not query any PETSc handle to recover this progress.
    result.ksp_monitor_registered = last_shifted_solve.monitor_registered;
    result.ksp_monitor_observation_count =
        last_shifted_solve.monitor_observation_count;
    result.ksp_monitor_last_iteration_available =
        last_shifted_solve.monitor_last_iteration_available;
    result.ksp_monitor_last_iteration =
        last_shifted_solve.monitor_last_iteration;
    result.ksp_monitor_recursive_residual_available =
        last_shifted_solve.monitor_recursive_residual_available;
    result.ksp_monitor_recursive_residual_norm =
        last_shifted_solve.monitor_recursive_residual_norm;
    result.ksp_monitor_last_reason_available =
        last_shifted_solve.monitor_last_reason_available;
    result.ksp_monitor_last_observed_reason =
        last_shifted_solve.monitor_last_observed_reason;
    result.ksp_true_residual_sample_count =
        last_shifted_solve.true_residual_sample_count;
    result.ksp_true_residual_measurement_failure_count =
        last_shifted_solve.true_residual_measurement_failure_count;
    result.ksp_true_criterion_solve_count = last_shifted_solve.criterion_solve_count;
    result.ksp_true_criterion_measured_count = last_shifted_solve.criterion_measured_count;
    result.ksp_true_criterion_violation_count = last_shifted_solve.criterion_violation_count;
    result.ksp_true_criterion_unavailable_count = last_shifted_solve.criterion_unavailable_count;
    if (last_shifted_solve.criterion_measured_count > 0) {
        result.ksp_true_criterion_maximum_tolerance_ratio =
            last_shifted_solve.criterion_maximum_tolerance_ratio;
    }
    if (last_shifted_solve.true_residual_sample_count > 0) {
        result.ksp_max_true_relative_residual =
            last_shifted_solve.maximum_true_relative_residual;
    }
    if (eps_solve_error != 0) {
        result.status = "solve_error";
        result.unsupported_reason =
            context.error_message[0] != '\0'
                ? "floquet_matshell_action_failed"
                : "floquet_slepc_solve_failed";
        // Do not query or mutate EPS, its ST/KSP, or any matrix in the
        // reusable context after this point.  SLEPc may still own a DSGetMat
        // view, so EPSDestroy and matrix destruction are unsafe.  Marking the
        // context invalid makes the production window stop before another
        // subwindow can touch the borrowed operators; teardown intentionally
        // leaves the process-bounded object graph alive for OS reclamation.
        state->invalidated = true;
        state->eps_lifetime_unsafe = true;
        if (shifted_ksp_true_convergence_test_registration_attempted) {
            // Keep the callback context alive with the intentionally retained
            // EPS/KSP graph after an unsafe hard failure.
            (void)shifted_ksp_true_convergence_context.release();
        }
        return result;
    }
    PetscInt resolved_nev = 0;
    PetscInt resolved_ncv = 0;
    PetscInt resolved_mpd = 0;
    if (EPSGetDimensions(eps, &resolved_nev, &resolved_ncv, &resolved_mpd) == 0 &&
        resolved_nev > 0 && resolved_ncv >= resolved_nev) {
        const PetscInt int_max = static_cast<PetscInt>(
            std::numeric_limits<int>::max());
        const PetscInt int_min = static_cast<PetscInt>(
            std::numeric_limits<int>::min());
        result.eps_nev = static_cast<int>(
            std::min(std::max<PetscInt>(int_min, resolved_nev), int_max));
        result.eps_ncv = static_cast<int>(
            std::min(std::max<PetscInt>(int_min, resolved_ncv), int_max));
        result.eps_mpd = static_cast<int>(
            std::min(std::max<PetscInt>(int_min, resolved_mpd), int_max));
        result.eps_dimensions_available = true;
    }
    // These values describe the inner shift-invert KSP, separately from the
    // EPS outer iteration count. KSPGetTotalIterations accumulates over every
    // linear solve made by this KSP object; the last-solve values identify
    // whether the final shift-invert action itself converged.
    PetscInt shifted_total_iterations = 0;
    PetscInt shifted_last_iterations = 0;
    PetscReal shifted_final_residual = PETSC_INFINITY;
    KSPConvergedReason shifted_converged_reason = KSP_CONVERGED_ITERATING;
    PetscErrorCode ksp_diagnostics_code =
        KSPGetTotalIterations(shifted_ksp, &shifted_total_iterations);
    if (ksp_diagnostics_code == 0) {
        ksp_diagnostics_code =
            KSPGetIterationNumber(shifted_ksp, &shifted_last_iterations);
    }
    if (ksp_diagnostics_code == 0) {
        ksp_diagnostics_code =
            KSPGetResidualNorm(shifted_ksp, &shifted_final_residual);
    }
    if (ksp_diagnostics_code == 0) {
        ksp_diagnostics_code =
            KSPGetConvergedReason(shifted_ksp, &shifted_converged_reason);
    }
    if (ksp_diagnostics_code == 0 &&
        (shifted_converged_reason != KSP_CONVERGED_ITERATING ||
         eps_solve_error != 0)) {
        const PetscInt int_max = static_cast<PetscInt>(
            std::numeric_limits<int>::max());
        result.linear_iterations_total = static_cast<int>(
            std::min(std::max<PetscInt>(0, shifted_total_iterations), int_max));
        result.ksp_last_iterations = static_cast<int>(
            std::min(std::max<PetscInt>(0, shifted_last_iterations), int_max));
        result.ksp_final_residual =
            static_cast<double>(shifted_final_residual);
        result.ksp_diagnostics_available = true;
        result.ksp_converged_reason_available = true;
        result.ksp_converged_reason =
            static_cast<int>(shifted_converged_reason);
    }
    // SLEPc may release the KSP's borrowed rhs and solution when EPSSolve
    // returns. The post-solve hook copied the last pair while both were live.
    // PETSc's reported norm may also be preconditioned, so compute the true
    // residual against the shifted operator with those owned copies.
    if (result.ksp_diagnostics_available && last_shifted_solve.available) {
        Vec true_residual = nullptr;
        PetscReal rhs_norm = 0.0;
        PetscReal residual_norm = 0.0;
        PCSide pc_side = PC_LEFT;
        KSPNormType norm_type = KSP_NORM_DEFAULT;
        const bool residual_measured =
            VecDuplicate(last_shifted_solve.rhs, &true_residual) == 0 &&
            MatMult(
                last_shifted_solve.shifted_operator,
                last_shifted_solve.solution,
                true_residual) == 0 &&
            VecAYPX(true_residual, -1.0, last_shifted_solve.rhs) == 0 &&
            VecNorm(last_shifted_solve.rhs, NORM_2, &rhs_norm) == 0 &&
            VecNorm(true_residual, NORM_2, &residual_norm) == 0 &&
            KSPGetPCSide(shifted_ksp, &pc_side) == 0 &&
            KSPGetNormType(shifted_ksp, &norm_type) == 0;
        if (true_residual != nullptr) {
            VecDestroy(&true_residual);
        }
        if (residual_measured &&
            std::isfinite(static_cast<double>(rhs_norm)) &&
            std::isfinite(static_cast<double>(residual_norm))) {
            result.ksp_last_true_residual_available = true;
            result.ksp_last_rhs_norm = static_cast<double>(rhs_norm);
            result.ksp_last_true_residual_norm =
                static_cast<double>(residual_norm);
            result.ksp_last_true_relative_residual =
                static_cast<double>(residual_norm) /
                std::max(static_cast<double>(rhs_norm),
                         std::numeric_limits<double>::min());
            result.ksp_pc_side = static_cast<int>(pc_side);
            result.ksp_norm_type = static_cast<int>(norm_type);
        }
    }

    // EPSGetIterationNumber/EPSGetConverged require PetscInt lvalues.  The
    // result fields are intentionally ABI-sized ints, so retrieve the values
    // again through local variables before candidate filtering.
    PetscInt outer_iterations = 0;
    PetscInt converged_eigenpair_count = 0;
    EPSConvergedReason converged_reason = EPS_CONVERGED_ITERATING;
    if (EPSGetIterationNumber(eps, &outer_iterations) != 0 ||
        EPSGetConverged(eps, &converged_eigenpair_count) != 0 ||
        EPSGetConvergedReason(eps, &converged_reason) != 0) {
        result.status = "solve_error";
        result.unsupported_reason = "floquet_slepc_convergence_query_failed";
        destroy_all();
        return result;
    }
    result.outer_iterations = static_cast<int>(outer_iterations);
    result.eps_converged_reason_available = true;
    result.eps_converged_reason = static_cast<int>(converged_reason);
    result.converged_eigenpair_count = static_cast<int>(converged_eigenpair_count);

    struct Candidate {
        SLEPcModalAcceptedMode mode{};
        double target_distance = 0.0;
    };
    std::vector<Candidate> candidates;
    candidates.reserve(static_cast<std::size_t>(
        std::max(1, spectral_request.requested_mode_count)));
    bool saw_positive_frequency = false;
    bool saw_window_candidate = false;
    bool saw_residual_rejection = false;
    bool saw_phi_failure = false;
    const bool filter_window = spectral_request.frequency_max_hz >
        spectral_request.frequency_min_hz && spectral_request.frequency_max_hz > 0.0;
    const double target_omega = omega_rad_s_from_frequency_hz(
        std::max(0.0, spectral_request.target_frequency_hz));
    for (PetscInt index = 0; index < converged_eigenpair_count; ++index) {
        PetscScalar kr = 0.0;
        PetscScalar ki = 0.0;
        PetscReal eps_absolute_residual = 0.0;
        if (EPSGetEigenpair(eps, index, &kr, &ki, xr, xi) != 0 ||
            EPSComputeError(eps, index, EPS_ERROR_ABSOLUTE, &eps_absolute_residual) != 0) {
            ++result.eigenpair_evaluation_failure_count;
            continue;
        }
        const double rotated_omega = static_cast<double>(PetscRealPart(kr));
        const double rotated_imaginary = static_cast<double>(PetscRealPart(ki));
        if (!std::isfinite(rotated_omega) || !std::isfinite(rotated_imaginary) ||
            std::abs(rotated_imaginary) >
                std::max(1.0e-8, 10.0 * static_cast<double>(eigen_tolerance)) *
                    std::max(1.0, std::abs(rotated_omega))) {
            ++result.non_real_rotated_eigenvalue_count;
            continue;
        }
        // The native operator is rotated to the real-frequency pencil
        // (-i*phase_sign*A)q = omega*Bq.  Convert the real EPS value back to
        // the canonical descriptor eigenvalue lambda=i*phase_sign*omega
        // before applying the original residual and frequency map.
        const double lambda_real = 0.0;
        const double lambda_imag =
            static_cast<double>(context.phase_sign) * rotated_omega;
        const ModeKinematics kinematics = map_eigenvalue(
            {lambda_real, lambda_imag},
            spectral_request.phase_convention);
        if (!select_positive_frequency_mode(
                kinematics,
                ZeroFrequencyModePolicy::exclude)) {
            continue;
        }
        saw_positive_frequency = true;
        ++result.positive_frequency_candidate_count;
        if (result.positive_frequency_candidate_count == 1) {
            result.min_candidate_frequency_hz = kinematics.frequency_hz;
            result.max_candidate_frequency_hz = kinematics.frequency_hz;
        } else {
            result.min_candidate_frequency_hz = std::min(
                result.min_candidate_frequency_hz,
                kinematics.frequency_hz);
            result.max_candidate_frequency_hz = std::max(
                result.max_candidate_frequency_hz,
                kinematics.frequency_hz);
        }
        if (filter_window &&
            (kinematics.frequency_hz < spectral_request.frequency_min_hz ||
             kinematics.frequency_hz > spectral_request.frequency_max_hz)) {
            continue;
        }
        saw_window_candidate = true;
        ++result.frequency_window_candidate_count;
        std::vector<Complex> split_eigenvector;
        if (!copy_native_floquet_eigenvector(xr, xi, split_dimension, split_eigenvector)) {
            ++result.mode_vector_failure_count;
            continue;
        }
        const std::vector<Complex> q = physical_complex_vector_from_split(
            split_eigenvector,
            operator_view.q_complex_dof_count);
        const double q_norm = complex_vector_norm(q);
        const double split_norm = complex_vector_norm(split_eigenvector);
        if (q.size() != static_cast<std::size_t>(operator_view.q_complex_dof_count) ||
            !std::isfinite(q_norm) ||
            !(q_norm > std::numeric_limits<double>::epsilon())) {
            ++result.mode_vector_failure_count;
            continue;
        }
        std::vector<Complex> phi;
        if (!solve_native_floquet_phi_for_physical_mode(&context, xr, xi, phi)) {
            saw_phi_failure = true;
            ++result.potential_reconstruction_failure_count;
            continue;
        }
        const Complex lambda(lambda_real, lambda_imag);
        const double magnetic_residual = floquet_magnetic_residual(
            operator_view, q, phi, lambda);
        const double unprojected_magnetic_residual =
            floquet_magnetic_residual(
                operator_view,
                q,
                phi,
                Complex(
                    -static_cast<double>(context.phase_sign) * rotated_imaginary,
                    lambda_imag));
        const double potential_residual = floquet_potential_residual(
            operator_view, q, phi);
        FloquetFullDescriptorDiagnostics full_descriptor{};
#if FULLMAG_HAS_MFEM_STACK
        const double full_certificate_tolerance = std::min(
            spectral_request.residual_tolerance,
            kFloquetPotentialResidualTolerance);
        full_descriptor = certify_floquet_full_descriptor(
            operator_view,
            q,
            phi,
            lambda,
            full_certificate_tolerance);
#endif
        const bool full_descriptor_required =
            operator_view.full_descriptor_assembly != nullptr;
        const double eps_normalized_absolute_residual =
            static_cast<double>(eps_absolute_residual);
        bool residual_components_finite =
            std::isfinite(eps_normalized_absolute_residual) &&
            std::isfinite(magnetic_residual) &&
            std::isfinite(potential_residual);
        double residual = residual_components_finite
            ? std::max({magnetic_residual, potential_residual})
            : std::numeric_limits<double>::infinity();
        if (full_descriptor_required) {
            if (!full_descriptor.available) {
                residual_components_finite = false;
                residual = std::numeric_limits<double>::infinity();
            } else {
                const double full_residual = std::max({
                    full_descriptor.magnetic_relative_residual,
                    full_descriptor.potential_relative_residual,
                    full_descriptor.scalar_phase_seam_relative_residual,
                    full_descriptor.tangent_frame_seam_relative_residual,
                    full_descriptor.cartesian_magnetic_seam_relative_residual,
                    full_descriptor.equilibrium_pair_relative_residual});
                residual_components_finite =
                    residual_components_finite && std::isfinite(full_residual) &&
                    full_descriptor.full_descriptor_certified;
                residual = residual_components_finite
                    ? std::max(residual, full_residual)
                    : std::numeric_limits<double>::infinity();
            }
        }
        const auto update_residual_max = [](double candidate, double &maximum) {
            if (!std::isfinite(candidate)) {
                maximum = std::numeric_limits<double>::infinity();
            } else if (std::isnan(maximum)) {
                maximum = candidate;
            } else if (std::isfinite(maximum)) {
                maximum = std::max(maximum, candidate);
            }
        };
        update_residual_max(
            eps_normalized_absolute_residual,
            result.max_eps_normalized_absolute_residual);
        update_residual_max(
            magnetic_residual,
            result.max_floquet_magnetic_relative_residual);
        update_residual_max(
            potential_residual,
            result.max_floquet_potential_relative_residual);
        const bool first_residual_candidate =
            result.residual_evaluation_candidate_count == 0;
        const bool residual_is_worse = std::isfinite(residual)
            ? std::isfinite(result.max_candidate_relative_residual) &&
                  residual > result.max_candidate_relative_residual
            : std::isfinite(result.max_candidate_relative_residual);
        if (first_residual_candidate || residual_is_worse) {
            result.worst_candidate_frequency_hz = kinematics.frequency_hz;
            result.worst_candidate_eps_normalized_absolute_residual =
                eps_normalized_absolute_residual;
            result.worst_candidate_floquet_magnetic_relative_residual =
                magnetic_residual;
            result.worst_candidate_floquet_potential_relative_residual =
                potential_residual;
            result.worst_candidate_unprojected_magnetic_relative_residual =
                unprojected_magnetic_residual;
            result.worst_candidate_rotated_imaginary_rad_s =
                rotated_imaginary;
            result.worst_candidate_q_projection_ratio =
                q_norm / std::max(split_norm, std::numeric_limits<double>::min());
        }
        ++result.residual_evaluation_candidate_count;
        if (std::isfinite(residual)) {
            if (std::isnan(result.max_candidate_relative_residual)) {
                result.max_candidate_relative_residual = residual;
            } else if (std::isfinite(result.max_candidate_relative_residual)) {
                result.max_candidate_relative_residual = std::max(
                    result.max_candidate_relative_residual,
                    residual);
            }
        } else {
            result.max_candidate_relative_residual =
                std::numeric_limits<double>::infinity();
        }
        if (!std::isfinite(residual) || residual > eigen_tolerance) {
            saw_residual_rejection = true;
            ++result.residual_rejection_count;
            continue;
        }
        Candidate candidate{};
        // Production shared-domain solves must also pass the independently
        // reconstructed weak-form and periodic seam checks. Direct sparse
        // fixtures without full assembly data remain explicitly uncertified.
        candidate.mode.floquet_descriptor_certified =
            full_descriptor.full_descriptor_certified;
        candidate.mode.floquet_seam_frame_certified =
            full_descriptor.seam_frame_certified;
        candidate.mode.floquet_gauge_policy_satisfied =
            full_descriptor.gauge_policy_satisfied;
        if (operator_view.boundary_kind != nullptr) {
            std::strncpy(
                candidate.mode.floquet_poisson_boundary_kind.data(),
                operator_view.boundary_kind,
                candidate.mode.floquet_poisson_boundary_kind.size() - 1u);
        }
        if (operator_view.gauge_policy != nullptr) {
            std::strncpy(
                candidate.mode.floquet_poisson_gauge_policy.data(),
                operator_view.gauge_policy,
                candidate.mode.floquet_poisson_gauge_policy.size() - 1u);
        }
        candidate.mode.floquet_magnetic_residual = magnetic_residual;
        candidate.mode.floquet_potential_residual = potential_residual;
        candidate.mode.floquet_full_magnetic_residual =
            full_descriptor.magnetic_relative_residual;
        candidate.mode.floquet_full_potential_residual =
            full_descriptor.potential_relative_residual;
        candidate.mode.floquet_scalar_phase_seam_residual =
            full_descriptor.scalar_phase_seam_relative_residual;
        candidate.mode.floquet_tangent_frame_seam_residual =
            full_descriptor.tangent_frame_seam_relative_residual;
        candidate.mode.floquet_cartesian_seam_residual =
            full_descriptor.cartesian_magnetic_seam_relative_residual;
        candidate.mode.floquet_equilibrium_pair_residual =
            full_descriptor.equilibrium_pair_relative_residual;
        candidate.mode.floquet_potential_real_split = std::move(phi);
        candidate.mode.eigenpair_index = static_cast<int>(index);
        candidate.mode.lambda_real = lambda_real;
        candidate.mode.lambda_imag = lambda_imag;
        candidate.mode.frequency_hz = kinematics.frequency_hz;
        candidate.mode.relative_residual = residual;
        candidate.mode.mode_vector = q;
        candidate.mode.floquet_mode_vector_physical_complex = true;
        candidate.target_distance =
            std::abs(kinematics.omega_rad_s - target_omega);
        candidates.push_back(std::move(candidate));
    }
    destroy_all();

    if (candidates.empty()) {
        result.status = "solve_error";
        if (converged_eigenpair_count == 0 && converged_reason < 0) {
            result.unsupported_reason = converged_reason == EPS_DIVERGED_ITS
                ? "floquet_slepc_iteration_limit_reached"
                : "floquet_slepc_no_converged_eigenpairs";
        } else if (!saw_positive_frequency) {
            result.unsupported_reason = "no_positive_frequency_eigenpair";
        } else if (filter_window && !saw_window_candidate) {
            result.unsupported_reason = "no_positive_frequency_eigenpair_in_window";
        } else if (saw_phi_failure) {
            result.unsupported_reason = "floquet_potential_reconstruction_failed";
        } else if (saw_residual_rejection) {
            result.unsupported_reason = "floquet_original_descriptor_residual_not_met";
        } else {
            result.unsupported_reason = "no_accepted_positive_frequency_mode";
        }
        return result;
    }
    std::sort(
        candidates.begin(),
        candidates.end(),
        [](const Candidate &left, const Candidate &right) {
            if (left.target_distance == right.target_distance) {
                return left.mode.frequency_hz < right.mode.frequency_hz;
            }
            return left.target_distance < right.target_distance;
        });
    const std::size_t accepted_limit = std::min<std::size_t>(
        candidates.size(),
        static_cast<std::size_t>(std::max(1, spectral_request.requested_mode_count)));
    candidates.resize(accepted_limit);
    std::sort(
        candidates.begin(),
        candidates.end(),
        [](const Candidate &left, const Candidate &right) {
            return left.mode.frequency_hz < right.mode.frequency_hz;
        });
    result.accepted_modes.reserve(candidates.size());
    for (std::size_t index = 0u; index < candidates.size(); ++index) {
        candidates[index].mode.positive_frequency_pair_index = static_cast<int>(index);
        result.max_relative_residual = std::max(
            result.max_relative_residual,
            candidates[index].mode.relative_residual);
        result.accepted_modes.push_back(std::move(candidates[index].mode));
    }
    result.accepted_mode_count = static_cast<int>(result.accepted_modes.size());
    const SLEPcModalAcceptedMode &first = result.accepted_modes.front();
    result.selected_eigenpair_index = first.eigenpair_index;
    result.lambda_real = first.lambda_real;
    result.lambda_imag = first.lambda_imag;
    result.frequency_hz = first.frequency_hz;
    result.relative_residual = first.relative_residual;
    result.ok = true;
    result.status = "ok";
    return result;
#endif
}

const char *floquet_modal_solver_model() noexcept
{
    return "floquet_real_frequency_slepc";
}

} // namespace fullmag::fem::frequency_domain

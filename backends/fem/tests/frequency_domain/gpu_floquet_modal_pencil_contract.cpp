#include "gpu/frequency_domain/modal_augmented_pencil.hpp"
#include "gpu/frequency_domain/modal_augmented_ritz.hpp"

#if FULLMAG_FEM_CUDSS_SHIFT_ENABLED
#include "gpu/frequency_domain/modal_cudss_shift.hpp"
#include <cuda_runtime_api.h>
#endif

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <vector>

namespace fd = fullmag::fem::frequency_domain;

namespace {

using Complex = std::complex<double>;
using ComplexCsr = fd::PoissonAirboxSharedDomainComplexCsrMatrix;

void require(bool passed, const char *message)
{
    if (!passed) {
        std::fprintf(stderr, "GPU Floquet modal pencil: %s\n", message);
        std::exit(1);
    }
}

ComplexCsr dense_csr(std::uint32_t rows, std::uint32_t columns, const std::vector<Complex> &dense)
{
    require(dense.size() == static_cast<std::size_t>(rows) * columns,
            "dense fixture has the wrong extent");
    ComplexCsr matrix;
    matrix.row_count = rows;
    matrix.column_count = columns;
    matrix.row_offsets.reserve(static_cast<std::size_t>(rows) + 1u);
    matrix.row_offsets.push_back(0u);
    for (std::uint32_t row = 0; row < rows; ++row) {
        for (std::uint32_t column = 0; column < columns; ++column) {
            const auto value = dense[static_cast<std::size_t>(row) * columns + column];
            if (value != Complex{}) {
                matrix.column_indices.push_back(column);
                matrix.values.push_back(value);
            }
        }
        matrix.row_offsets.push_back(static_cast<std::uint32_t>(matrix.values.size()));
    }
    return matrix;
}

Complex csr_value(const ComplexCsr &matrix, std::uint32_t row, std::uint32_t column)
{
    const auto begin = matrix.row_offsets[row];
    const auto end = matrix.row_offsets[row + 1u];
    const auto first = matrix.column_indices.begin() + begin;
    const auto last = matrix.column_indices.begin() + end;
    const auto found = std::lower_bound(first, last, column);
    return found != last && *found == column
        ? matrix.values[static_cast<std::size_t>(found - matrix.column_indices.begin())]
        : Complex{};
}

struct ComplexBlock {
    std::uint32_t rows = 0;
    std::vector<Complex> values;
};

ComplexBlock multiply(const ComplexCsr &matrix, const std::vector<Complex> &vector)
{
    require(vector.size() == matrix.column_count, "dense residual vector has the wrong length");
    ComplexBlock result;
    result.rows = static_cast<std::uint32_t>(matrix.row_count);
    result.values.assign(result.rows, Complex{});
    for (std::uint32_t row = 0; row < result.rows; ++row) {
        for (auto entry = matrix.row_offsets[row]; entry < matrix.row_offsets[row + 1u]; ++entry) {
            result.values[row] += matrix.values[entry] * vector[matrix.column_indices[entry]];
        }
    }
    return result;
}

struct Fixture {
    ComplexCsr a_qq;
    ComplexCsr b_qq;
    ComplexCsr p;
    ComplexCsr a_qphi;
    ComplexCsr a_phiq;

    fd::gpu::FloquetAirboxAugmentedPencilView view() const
    {
        return {a_qq, b_qq, p, a_qphi, a_phiq};
    }
};

Fixture make_fixture()
{
    Fixture fixture;
    fixture.a_qq = dense_csr(2u, 2u, {
        8.0, Complex(1.0, 0.5),
        Complex(1.0, -0.5), 6.0});
    fixture.b_qq = dense_csr(2u, 2u, {
        0.0, Complex(1.0, 0.25),
        Complex(-1.0, 0.25), 0.0});
    fixture.p = dense_csr(2u, 2u, {
        4.0, Complex(0.5, 0.75),
        Complex(0.5, -0.75), 3.0});
    fixture.a_qphi = dense_csr(2u, 2u, {
        Complex(1.0, 0.5), Complex(-0.25, 0.75),
        Complex(0.5, -0.125), Complex(1.25, -0.25)});
    // Reciprocal full-field coupling: A_qphi = -mu0 * A_phiq^H, mu0=1 here.
    fixture.a_phiq = dense_csr(2u, 2u, {
        Complex(-1.0, 0.5), Complex(-0.5, -0.125),
        Complex(0.25, 0.75), Complex(-1.25, -0.25)});
    return fixture;
}

std::vector<Complex> expected_shifted_dense(const Fixture &fixture, double operator_scale,
                                             double shifted_mass_coefficient, double mu0)
{
    constexpr std::uint32_t q = 2u;
    constexpr std::uint32_t phi = 2u;
    constexpr std::uint32_t n = q + phi;
    std::vector<Complex> result(static_cast<std::size_t>(n) * n, Complex{});
    const Complex minus_i_shift(0.0, -shifted_mass_coefficient);
    for (std::uint32_t row = 0; row < q; ++row) {
        for (std::uint32_t column = 0; column < q; ++column) {
            result[static_cast<std::size_t>(row) * n + column] =
                operator_scale * csr_value(fixture.a_qq, row, column) +
                minus_i_shift * csr_value(fixture.b_qq, row, column);
        }
        for (std::uint32_t column = 0; column < phi; ++column) {
            result[static_cast<std::size_t>(row) * n + q + column] =
                operator_scale * csr_value(fixture.a_qphi, row, column);
        }
    }
    for (std::uint32_t row = 0; row < phi; ++row) {
        for (std::uint32_t column = 0; column < q; ++column) {
            result[static_cast<std::size_t>(q + row) * n + column] =
                -operator_scale * mu0 * csr_value(fixture.a_phiq, row, column);
        }
        for (std::uint32_t column = 0; column < phi; ++column) {
            result[static_cast<std::size_t>(q + row) * n + q + column] =
                -operator_scale * mu0 * csr_value(fixture.p, row, column);
        }
    }
    return result;
}

void verify_complex_assembly(const Fixture &fixture,
                             const fd::gpu::OpenAirboxAugmentedPencil &pencil,
                             const std::vector<Complex> &raw)
{
    constexpr std::uint32_t n = 4u;
    require(pencil.complex_csr.row_count == n && pencil.complex_csr.column_count == n,
            "Floquet augmented pencil has the wrong dimension");
    require(pencil.equilibration.size() == n, "Floquet equilibration has the wrong length");
    for (std::uint32_t row = 0; row < n; ++row) {
        double row_norm = 0.0;
        for (std::uint32_t column = 0; column < n; ++column) {
            row_norm += std::abs(raw[static_cast<std::size_t>(row) * n + column]);
        }
        require(row_norm > 0.0 && std::isfinite(row_norm), "oracle row has no finite norm");
        require(std::abs(pencil.equilibration[row] * std::sqrt(row_norm) - 1.0) < 2.0e-14,
                "Floquet pencil used a different equilibration");
        for (std::uint32_t column = 0; column < n; ++column) {
            const auto actual = csr_value(pencil.complex_csr, row, column);
            const auto expected = pencil.equilibration[row] * raw[static_cast<std::size_t>(row) * n + column] *
                pencil.equilibration[column];
            require(std::abs(actual - expected) < 3.0e-14,
                    "Floquet pencil lost a complex coefficient or shifted block scale");
        }
    }
    require(std::abs(csr_value(fixture.a_qq, 0u, 1u).imag()) > 0.0 &&
                std::abs(csr_value(fixture.b_qq, 0u, 1u).imag()) > 0.0 &&
                std::abs(csr_value(fixture.p, 0u, 1u).imag()) > 0.0 &&
                std::abs(csr_value(fixture.a_qphi, 0u, 0u).imag()) > 0.0,
            "synthetic fixture must have genuinely complex original blocks");
    require(csr_value(fixture.b_qq, 0u, 0u) == Complex{} &&
                csr_value(fixture.b_qq, 1u, 1u) == Complex{} &&
                std::abs(Complex(0.0, 1.0) * csr_value(fixture.b_qq, 0u, 1u)) > 0.0,
            "synthetic i*B must have the expected indefinite gyrotropic signature");
}

void verify_rejects_invalid_block_identities(const Fixture &fixture)
{
    constexpr double operator_scale = 1.0;
    constexpr double shifted_mass_coefficient = 0.3;
    constexpr double mu0 = 1.0;

    auto bad_a = fixture;
    bad_a.a_qq.values[1] += Complex(0.0, 0.01);
    auto bad_a_view = bad_a.view();
    require(!fd::gpu::assemble_floquet_airbox_augmented_pencil(
                bad_a_view, operator_scale, shifted_mass_coefficient, mu0),
            "non-Hermitian A_qq was accepted");

    auto bad_b = fixture;
    bad_b.b_qq.values.back() += Complex(0.01, 0.0);
    auto bad_b_view = bad_b.view();
    require(!fd::gpu::assemble_floquet_airbox_augmented_pencil(
                bad_b_view, operator_scale, shifted_mass_coefficient, mu0),
            "non-skew-Hermitian B_qq was accepted");

    auto bad_p = fixture;
    bad_p.p.values[1] += Complex(0.0, 0.01);
    auto bad_p_view = bad_p.view();
    require(!fd::gpu::assemble_floquet_airbox_augmented_pencil(
                bad_p_view, operator_scale, shifted_mass_coefficient, mu0),
            "non-Hermitian P was accepted");

    auto bad_coupling = fixture;
    bad_coupling.a_phiq.values[0] += Complex(0.01, 0.0);
    auto bad_coupling_view = bad_coupling.view();
    require(!fd::gpu::assemble_floquet_airbox_augmented_pencil(
                bad_coupling_view, operator_scale, shifted_mass_coefficient, mu0),
            "nonreciprocal A_qphi/A_phiq coupling was accepted");
}

std::vector<Complex> multiply_dense(const std::vector<Complex> &matrix, std::uint32_t rows,
                                    std::uint32_t columns, const std::vector<Complex> &vector)
{
    require(matrix.size() == static_cast<std::size_t>(rows) * columns && vector.size() == columns,
            "dense oracle input has inconsistent dimensions");
    std::vector<Complex> result(rows, Complex{});
    for (std::uint32_t row = 0; row < rows; ++row) {
        for (std::uint32_t column = 0; column < columns; ++column) {
            result[row] += matrix[static_cast<std::size_t>(row) * columns + column] * vector[column];
        }
    }
    return result;
}

double vector_norm(const std::vector<Complex> &vector)
{
    double squared = 0.0;
    for (const auto value : vector) {
        squared += std::norm(value);
    }
    return std::sqrt(squared);
}

void verify_original_complex_residuals(const Fixture &fixture, const fd::gpu::AugmentedRitzBlock &ritz,
                                      double operator_scale, double mass_scale)
{
    constexpr std::uint32_t q = 2u;
    constexpr std::uint32_t phi = 2u;
    constexpr std::uint32_t dimension = q + phi;
    require(ritz.candidates.size() == 2u && ritz.vectors.size() == 2u * dimension,
            "Floquet Ritz block has the wrong shape");
    const double angular_frequency_scale = mass_scale / operator_scale;
    std::size_t positive_modes = 0u, negative_modes = 0u;
    for (std::size_t mode = 0; mode < ritz.candidates.size(); ++mode) {
        const auto &candidate = ritz.candidates[mode];
        require(std::isfinite(candidate.inverse_scaled_eigenvalue) &&
                    std::abs(candidate.inverse_scaled_eigenvalue) > 0.0,
                "Floquet Ritz candidate has an invalid inverse eigenvalue");
        positive_modes += candidate.inverse_scaled_eigenvalue > 0.0 ? 1u : 0u;
        negative_modes += candidate.inverse_scaled_eigenvalue < 0.0 ? 1u : 0u;
        const double omega = angular_frequency_scale / candidate.inverse_scaled_eigenvalue;
        std::vector<Complex> q_vector(q), phi_vector(phi);
        for (std::uint32_t row = 0; row < q; ++row) {
            q_vector[row] = ritz.vectors[mode * dimension + row];
        }
        for (std::uint32_t row = 0; row < phi; ++row) {
            phi_vector[row] = ritz.vectors[mode * dimension + q + row];
        }

        const auto a_q = multiply(fixture.a_qq, q_vector).values;
        const auto qphi = multiply(fixture.a_qphi, phi_vector).values;
        const auto b_q = multiply(fixture.b_qq, q_vector).values;
        const auto phiq = multiply(fixture.a_phiq, q_vector).values;
        const auto p_phi = multiply(fixture.p, phi_vector).values;
        std::vector<Complex> q_residual(q), gyro_term(q), phi_residual(phi);
        for (std::uint32_t row = 0; row < q; ++row) {
            gyro_term[row] = Complex(0.0, -omega) * b_q[row];
            q_residual[row] = a_q[row] + qphi[row] + gyro_term[row];
        }
        for (std::uint32_t row = 0; row < phi; ++row) {
            phi_residual[row] = phiq[row] + p_phi[row];
        }
        const double q_relative = vector_norm(q_residual) /
            (vector_norm(a_q) + vector_norm(qphi) + vector_norm(gyro_term) + 1.0e-30);
        const double phi_relative = vector_norm(phi_residual) /
            (vector_norm(phiq) + vector_norm(p_phi) + 1.0e-30);
        require(q_relative < 1.0e-8 && phi_relative < 1.0e-8,
                "independent original complex block residual is too large");
        require(std::abs(q_relative - candidate.magnetic_relative_residual) < 2.0e-8 &&
                    std::abs(phi_relative - candidate.poisson_relative_residual) < 2.0e-8,
                "reported Floquet residual differs from the original complex equations");
    }
    require(positive_modes == 1u && negative_modes == 1u,
            "indefinite gyrotropic block did not retain both signed modes");
}

#if FULLMAG_FEM_CUDSS_SHIFT_ENABLED
void check_cuda(cudaError_t status)
{
    require(status == cudaSuccess, cudaGetErrorString(status));
}

void verify_cudss_dense_oracle(const fd::gpu::OpenAirboxAugmentedPencil &pencil,
                               const std::vector<Complex> &raw)
{
    constexpr std::uint32_t n = 4u;
    constexpr int rhs_count = 2;
    const std::vector<Complex> expected_solution{
        Complex(1.0, -0.5), Complex(-0.25, 2.0), Complex(0.75, 0.125), Complex(-1.5, 0.25),
        Complex(-0.5, 0.75), Complex(1.25, -0.25), Complex(0.375, 1.5), Complex(0.625, -1.0)};
    std::vector<double2> rhs(expected_solution.size()), solution(expected_solution.size());
    for (int column = 0; column < rhs_count; ++column) {
        for (std::uint32_t row = 0; row < n; ++row) {
            Complex value{};
            for (std::uint32_t inner = 0; inner < n; ++inner) {
                value += pencil.equilibration[row] * raw[static_cast<std::size_t>(row) * n + inner] *
                    pencil.equilibration[inner] * expected_solution[column * n + inner];
            }
            rhs[column * n + row] = {value.real(), value.imag()};
        }
    }

    cudaStream_t stream = nullptr;
    check_cuda(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking));
    {
        const char *failure = nullptr;
        auto factor = fd::gpu::CudssModalShift::create(pencil, rhs_count, stream, &failure);
        require(factor != nullptr, failure ? failure : "complex cuDSS factor is missing");
        require(factor->negative_inertia() == 2,
                "complex cuDSS factor has the wrong negative inertia");
        check_cuda(cudaMemcpyAsync(factor->rhs(), rhs.data(), rhs.size() * sizeof(rhs[0]),
                                   cudaMemcpyHostToDevice, stream));
        require(factor->enqueue(), "complex cuDSS solve failed");
        check_cuda(cudaMemcpyAsync(solution.data(), factor->solution(), solution.size() * sizeof(solution[0]),
                                   cudaMemcpyDeviceToHost, stream));
        check_cuda(cudaStreamSynchronize(stream));
    }
    check_cuda(cudaStreamDestroy(stream));
    for (std::size_t index = 0; index < solution.size(); ++index) {
        const double error = std::hypot(solution[index].x - expected_solution[index].real(),
                                        solution[index].y - expected_solution[index].imag());
        require(error < 2.0e-11, "complex cuDSS result differs from the dense Hermitian oracle");
    }
}
#endif

} // namespace

void verify_gpu_floquet_modal_pencil()
{
    constexpr double operator_scale = 1.0;
    constexpr double mass_scale = 1.0;
    constexpr double shift = 0.3;
    constexpr double shifted_mass_coefficient = mass_scale * shift;
    constexpr double mu0 = 1.0;
    auto fixture = make_fixture();
    auto view = fixture.view();
    const auto raw = expected_shifted_dense(fixture, operator_scale, shifted_mass_coefficient, mu0);
    auto pencil = fd::gpu::assemble_floquet_airbox_augmented_pencil(
        view, operator_scale, shifted_mass_coefficient, mu0);
    require(pencil.has_value(), "complex reciprocal Floquet blocks were rejected");
    require(pencil->potential_row_scale == -operator_scale * mu0,
            "wrong Floquet potential row multiplier");
    verify_complex_assembly(fixture, *pencil, raw);
    verify_rejects_invalid_block_identities(fixture);

#if FULLMAG_FEM_CUDSS_SHIFT_ENABLED
    verify_cudss_dense_oracle(*pencil, raw);
    fd::PoissonAirboxEigenBlockProblem controls;
    controls.q_dof_count = 2u;
    controls.phi_dof_count = 2u;
    controls.max_outer_iterations = 1u;
    const char *failure = nullptr;
    const auto ritz = fd::gpu::solve_floquet_airbox_augmented_ritz(
        controls, view, operator_scale, mass_scale, shift, mu0, 2, &failure);
    require(ritz.has_value(), failure ? failure : "complex Floquet Ritz block is missing");
    require(ritz->measurements.checked_release && ritz->negative_shift_inertia == 2,
            "Floquet Ritz block did not report released resources and shifted inertia");
    verify_original_complex_residuals(fixture, *ritz, operator_scale, mass_scale);
#endif
    std::fprintf(stderr, "GPU Floquet modal pencil passed the complex dense-oracle contract\n");
}

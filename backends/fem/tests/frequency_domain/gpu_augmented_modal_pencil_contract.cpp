#include "gpu/frequency_domain/modal_augmented_pencil.hpp"

#if FULLMAG_FEM_CUDSS_SHIFT_ENABLED
#include "gpu/frequency_domain/modal_augmented_qr.hpp"
#include "gpu/frequency_domain/modal_augmented_ritz.hpp"
#include "gpu/frequency_domain/modal_augmented_window.hpp"
#include "gpu/frequency_domain/modal_cudss_shift.hpp"
#include <cuda_runtime_api.h>
#endif

#include <array>
#include <cmath>
#include <complex>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>

namespace {

namespace fd = fullmag::fem::frequency_domain;

void require(bool passed, const char *message)
{
    if (!passed) {
        std::fprintf(stderr, "GPU augmented modal pencil: %s\n", message);
        std::exit(1);
    }
}

template <std::size_t R, std::size_t N>
fd::CsrMatrixView view(
    std::uint64_t columns, const std::array<std::uint32_t, R> &offsets,
    const std::array<std::uint32_t, N> &indices, const std::array<double, N> &values)
{
    return {R - 1u, columns, offsets.data(), R, indices.data(), N, values.data(), N};
}

#if FULLMAG_FEM_CUDSS_SHIFT_ENABLED
void check_cuda(cudaError_t status)
{
    require(status == cudaSuccess, cudaGetErrorString(status));
}

void verify_augmented_qr()
{
    using Complex = std::complex<double>;
    const std::array<Complex, 4> original{Complex(3., 1.), Complex(1., -2.),
                                           Complex(5., 3.), Complex(2., 1.)};
    const double2 unity{1., 0.};
    std::array<double2, 6> input{}, output{};
    for (int col = 0; col < 2; ++col) {
        const auto a = original[2 * col];
        const auto b = original[2 * col + 1];
        const auto phi = -(3. * a + 5. * b) / 4.;
        input[3 * col] = {a.real(), a.imag()};
        input[3 * col + 1] = {b.real(), b.imag()};
        input[3 * col + 2] = {phi.real(), phi.imag()};
    }
    cudaStream_t stream = nullptr;
    check_cuda(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking));
    cublasHandle_t blas = nullptr;
    cusolverDnHandle_t solver = nullptr;
    require(cublasCreate(&blas) == CUBLAS_STATUS_SUCCESS &&
                cublasSetStream(blas, stream) == CUBLAS_STATUS_SUCCESS &&
                cublasSetPointerMode(blas, CUBLAS_POINTER_MODE_DEVICE) == CUBLAS_STATUS_SUCCESS,
            "failed to prepare cuBLAS for lifted QR");
    require(cusolverDnCreate(&solver) == CUSOLVER_STATUS_SUCCESS &&
                cusolverDnSetStream(solver, stream) == CUSOLVER_STATUS_SUCCESS,
            "failed to prepare cuSOLVER for lifted QR");
    double2 *basis = nullptr, *solved = nullptr, *lifted = nullptr, *device_one = nullptr;
    check_cuda(cudaMalloc(&basis, 4 * sizeof(double2)));
    check_cuda(cudaMalloc(&solved, sizeof(input)));
    check_cuda(cudaMalloc(&lifted, sizeof(output)));
    check_cuda(cudaMalloc(&device_one, sizeof(unity)));
    check_cuda(cudaMemcpyAsync(solved, input.data(), sizeof(input), cudaMemcpyHostToDevice, stream));
    check_cuda(cudaMemcpyAsync(device_one, &unity, sizeof(unity), cudaMemcpyHostToDevice, stream));
    check_cuda(cudaMemcpy2DAsync(basis, 2 * sizeof(double2), solved, 3 * sizeof(double2),
                                2 * sizeof(double2), 2, cudaMemcpyDeviceToDevice, stream));
    {
        auto qr = fd::gpu::AugmentedModalQr::create(2, 1, 2, 3, basis, solver, blas, stream);
        require(qr != nullptr, "failed to prepare augmented QR workspace");
        require(!qr->enqueue(solved, lifted, device_one), "accepted factor output before the seed");
        require(qr->enqueue(nullptr), "failed to normalize the starting block");
        require(qr->enqueue(solved, lifted, device_one), "failed to normalize the augmented basis");
        require(qr->complete(), "nonzero augmented QR status");
        check_cuda(cudaMemcpy(output.data(), lifted, sizeof(output), cudaMemcpyDeviceToHost));
    }
    check_cuda(cudaFree(device_one));
    check_cuda(cudaFree(lifted));
    check_cuda(cudaFree(solved));
    check_cuda(cudaFree(basis));
    require(cusolverDnDestroy(solver) == CUSOLVER_STATUS_SUCCESS, "failed to close lifted QR cuSOLVER handle");
    require(cublasDestroy(blas) == CUBLAS_STATUS_SUCCESS, "failed to close lifted QR cuBLAS handle");
    check_cuda(cudaStreamDestroy(stream));

    const auto element = [&](int row, int col) {
        const auto item = output[3 * col + row];
        return Complex(item.x, item.y);
    };
    for (int i = 0; i < 2; ++i) {
        const auto defect = 3. * element(0, i) + 5. * element(1, i) + 4. * element(2, i);
        require(std::abs(defect) <= 1e-12, "lifted QR did not preserve the Poisson constraint");
        for (int j = 0; j < 2; ++j) {
            const auto dot = std::conj(element(0, i)) * element(0, j) +
                std::conj(element(1, i)) * element(1, j);
            require(std::abs(dot - (i == j ? 1. : 0.)) <= 1e-12, "lifted QR basis is not orthonormal");
        }
    }
    std::fprintf(stderr, "GPU lifted QR basis passed the orthogonality and Poisson constraints\n");
}

void verify_cudss_factor(const fd::gpu::OpenAirboxAugmentedPencil &pencil,
                        const std::array<std::complex<double>, 9> &original)
{
    constexpr int column_count = 40;
    std::array<double2, 3 * column_count> rhs{}, expected{}, output{};
    for (int column = 0; column < column_count; ++column) {
        for (int i = 0; i < 3; ++i) {
            expected[3 * column + i] = {1. + 0.25 * (i - column), 0.5 * (i + column)};
        }
        for (int i = 0; i < 3; ++i) {
            std::complex<double> value{};
            for (int j = 0; j < 3; ++j) {
                const auto item = expected[3 * column + j];
                value += original[3 * i + j] * std::complex<double>(item.x, item.y) *
                    pencil.equilibration[i] * pencil.equilibration[j];
            }
            rhs[3 * column + i] = {value.real(), value.imag()};
        }
    }

    cudaStream_t stream = nullptr;
    check_cuda(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking));
    {
        const char *failure = nullptr;
        auto factor = fd::gpu::CudssModalShift::create(pencil, column_count, stream, &failure, 1);
        require(factor == nullptr && failure != nullptr &&
                    std::strcmp(failure, "cudss_peak_memory_budget_exceeded") == 0,
                failure != nullptr ? failure : "cuDSS did not reject a one-byte device budget");
    }
    {
        const char *failure = nullptr;
        auto factor = fd::gpu::CudssModalShift::create(pencil, column_count, stream, &failure);
        require(factor != nullptr, failure != nullptr ? failure : "cuDSS factor is missing");
        require(factor->negative_inertia() == 1, "cuDSS factor reports the wrong negative index of inertia");
        check_cuda(cudaMemcpyAsync(factor->rhs(), rhs.data(), sizeof(rhs), cudaMemcpyHostToDevice, stream));
        require(factor->enqueue(), "warm cuDSS block solve failed");
        check_cuda(cudaStreamSynchronize(stream));
        check_cuda(cudaStreamBeginCapture(stream, cudaStreamCaptureModeThreadLocal));
        require(factor->enqueue(), "preallocated cuDSS block solve failed under capture");
        cudaGraph_t graph = nullptr;
        check_cuda(cudaStreamEndCapture(stream, &graph));
        std::size_t node_count = 0;
        check_cuda(cudaGraphGetNodes(graph, nullptr, &node_count));
        require(node_count != 0, "empty cuDSS block solve graph");
        std::vector<cudaGraphNode_t> nodes(node_count);
        check_cuda(cudaGraphGetNodes(graph, nodes.data(), &node_count));
        for (const auto node : nodes) {
            cudaGraphNodeType type{};
            check_cuda(cudaGraphNodeGetType(node, &type));
            require(type != cudaGraphNodeTypeMemAlloc && type != cudaGraphNodeTypeMemFree &&
                        type != cudaGraphNodeTypeHost,
                    "cuDSS block solve graph contains an allocation, free, or host callback");
        }
        cudaGraphExec_t replay = nullptr;
        check_cuda(cudaGraphInstantiate(&replay, graph, 0));
        for (int iteration = 0; iteration < 2; ++iteration) {
            check_cuda(cudaGraphLaunch(replay, stream));
        }
        check_cuda(cudaMemcpyAsync(output.data(), factor->solution(), sizeof(output), cudaMemcpyDeviceToHost, stream));
        check_cuda(cudaStreamSynchronize(stream));
        check_cuda(cudaGraphExecDestroy(replay));
        check_cuda(cudaGraphDestroy(graph));
        require(factor->prepare_device_replay(&failure),
                failure ? failure : "failed to qualify the device-only shifted graph");
        check_cuda(cudaMemcpyAsync(factor->rhs(), rhs.data(), sizeof(rhs), cudaMemcpyHostToDevice, stream));
        for (int iteration = 0; iteration < 2; ++iteration) {
            require(factor->enqueue_device_replay(), "qualified shifted device graph launch failed");
        }
        check_cuda(cudaMemcpyAsync(output.data(), factor->solution(), sizeof(output), cudaMemcpyDeviceToHost, stream));
        check_cuda(cudaStreamSynchronize(stream));
    }
    check_cuda(cudaStreamDestroy(stream));
    for (std::size_t index = 0; index < output.size(); ++index) {
        const auto error = std::hypot(output[index].x - expected[index].x, output[index].y - expected[index].y);
        require(error < 1e-11, "cuDSS shifted solve differs from the independently generated right-hand side");
    }
    std::fprintf(stderr, "GPU augmented cuDSS factor passed with %d right-hand sides\n", column_count);
}
#endif

} // namespace

void verify_gpu_augmented_modal_pencil()
{
    constexpr std::array<std::uint32_t, 3> square_rows{0, 2, 4};
    constexpr std::array<std::uint32_t, 4> square_columns{0, 1, 0, 1};
    constexpr std::array<std::uint32_t, 3> two_rows{0, 1, 2};
    constexpr std::array<std::uint32_t, 2> two_in_row{0, 2};
    constexpr std::array<std::uint32_t, 2> one_row{0, 1};
    constexpr std::array<std::uint32_t, 2> off_diagonal{1, 0};
    constexpr std::array<std::uint32_t, 2> horizontal{0, 1};
    constexpr std::array<std::uint32_t, 2> vertical{0, 0};
    constexpr std::array<std::uint32_t, 1> diagonal{0};
    constexpr std::array<double, 4> stiffness{8., 1., 1., 5.};
    constexpr std::array<double, 2> gyro{2., -2.};
    constexpr std::array<double, 2> magnetic_to_potential{3., 5.};
    constexpr std::array<double, 2> potential_to_magnetic{-.75, -1.25};
    constexpr std::array<double, 1> potential{4.};
    fd::PoissonAirboxEigenBlockProblem problem;
    problem.q_dof_count = 2;
    problem.phi_dof_count = 1;
    problem.demag_kind = "open_airbox_k0";
    problem.outer_boundary_kind = "poisson_robin";
    problem.gauge_policy = "none";
    problem.A_qq = view(2, square_rows, square_columns, stiffness);
    problem.B_qq = view(2, two_rows, off_diagonal, gyro);
    problem.A_qphi = view(1, two_rows, vertical, potential_to_magnetic);
    problem.A_phiq = view(2, two_in_row, horizontal, magnetic_to_potential);
    problem.A_phiphi = view(1, one_row, diagonal, potential);

    using Complex = std::complex<double>;
    const std::array<Complex, 9> expected{
        16., Complex(2., -12.), -1.5,
        Complex(2., 12.), 10., -2.5,
        -1.5, -2.5, -2.
    };
    auto result = fd::gpu::assemble_open_airbox_augmented_pencil(problem, 2., 6., 0.25);
    require(result.has_value(), "reciprocal Robin pencil rejected");
    require(result->complex_csr.row_offsets == std::vector<std::uint32_t>{0, 3, 6, 9},
            "wrong sparse augmented row structure");
    require(result->complex_csr.column_indices == std::vector<std::uint32_t>{0, 1, 2, 0, 1, 2, 0, 1, 2},
            "wrong sparse augmented columns");
    for (std::size_t i = 0; i < 3; ++i) {
        double row_norm = 0;
        for (std::size_t j = 0; j < 3; ++j) {
            row_norm += std::abs(expected[3 * i + j]);
        }
        require(std::abs(result->equilibration[i] * std::sqrt(row_norm) - 1.) < 1e-14,
                "wrong equilibration");
        for (std::size_t j = 0; j < 3; ++j) {
            const double scale = result->equilibration[i] * result->equilibration[j];
            require(std::abs(result->complex_csr.values[3 * i + j] - scale * expected[3 * i + j]) < 1e-14,
                    "different native complex shifted operator");
        }
    }
    require(result->potential_row_scale == -0.5, "wrong original potential row multiplier");
#if FULLMAG_FEM_CUDSS_SHIFT_ENABLED
    verify_cudss_factor(*result, expected);
    verify_augmented_qr();
    problem.max_outer_iterations = 2;
    const char *failure = nullptr;
    const auto ritz = fd::gpu::solve_open_airbox_augmented_ritz(problem, 1., 1., 0.5, 0.25, 2, &failure);
    require(ritz.has_value(), failure ? failure : "augmented Ritz block is missing");
    require(ritz->measurements.checked_release && ritz->measurements.qualified_graph_nodes != 0,
            "augmented Ritz block did not release the measured CUDA objects");
#if FULLMAG_FEM_CUDSS_TRACE_CONTRACT
    namespace trace = fullmag::fem::cuda_trace;
    const auto &activity = ritz->native_trace;
    require(activity.flags == trace::modal_eps_trace_complete && activity.kernel_records > 0,
            "augmented Ritz block CUPTI measurement did not complete");
    require((activity.counter_coverage & trace::modal_eps_counter_coverage_scalar_telemetry_d2h) != 0 &&
                activity.scalar_telemetry_d2h_count == 0 && activity.scalar_telemetry_d2h_bytes == 0,
            "lossless no-D2H measurement did not certify zero scalar telemetry");
    require(activity.h2d_count == 0 && activity.d2h_count == 0 &&
                activity.allocation_count == 0 && activity.release_count == 0 &&
                activity.host_sync_count == 0,
            "augmented Ritz block iteration migrated data, allocated or synchronized the host");
#endif
    require(ritz->candidates.size() == 2 && ritz->vectors.size() == 6 &&
                ritz->negative_shift_inertia == 1, "unexpected augmented Ritz block shape or inertia");

    constexpr double h00 = 8. + 9. / 16.;
    constexpr double h11 = 5. + 25. / 16.;
    constexpr double h01 = 1. + 15. / 16.;
    const double inverse_expected = 2. / std::sqrt(h00 * h11 - h01 * h01);
    const auto &positive = ritz->candidates[0];
    const auto &negative = ritz->candidates[1];
    require(std::abs(positive.inverse_scaled_eigenvalue + negative.inverse_scaled_eigenvalue) <= 1e-12,
            "augmented Ritz block lost the signed pair");
    for (const auto &candidate : ritz->candidates) {
        require(std::abs(std::abs(candidate.inverse_scaled_eigenvalue) - inverse_expected) <= 1e-12,
                "augmented Ritz eigenvalue differs from the exact Schur value");
        require(candidate.magnetic_relative_residual <= 1e-11 && candidate.poisson_relative_residual <= 1e-11,
                "augmented Ritz eigenvector failed the original block equations");
    }
    std::fprintf(stderr, "GPU augmented Ritz block passed the original modal equations\n");
    problem.target_kind = "frequency_window";
    problem.frequency_min_hz = 0.1;
    problem.frequency_max_hz = 0.8;
    problem.requested_mode_count = 1;
    const auto window = fd::gpu::solve_open_airbox_augmented_window(problem, 1., 1., 1., 0.25, &failure);
    require(window.has_value(), failure ? failure : "GPU augmented window is missing");
    require(window->certified_mode_count == 1 && window->modes.size() == 1 &&
                !window->truncated_by_requested_count, "GPU augmented window did not certify one positive branch");
    const double expected_hz = 1. / (6.2831853071795864769 * inverse_expected);
    require(std::abs(window->modes.front().frequency_hz - expected_hz) <= 1e-12,
            "GPU augmented window published a different frequency");
    problem.frequency_max_hz = expected_hz;
    require(!fd::gpu::solve_open_airbox_augmented_window(problem, 1., 1., 1., 0.25, &failure),
            "GPU augmented window accepted a boundary inside its spectral uncertainty guard");
    problem.target_kind = "nearest_frequency";
    problem.frequency_min_hz = problem.frequency_max_hz = 0.0;
    std::fprintf(stderr, "GPU augmented window passed positive-mode count and endpoint checks\n");
    problem.target_frequency_hz = expected_hz * 1.02;
    const auto nearest = fd::gpu::solve_open_airbox_augmented_nearest(problem, 1., 1., 1., 0.25, &failure);
    require(nearest.has_value(), failure ? failure : "GPU nearest-mode bracket is missing");
    require(nearest->modes.size() == 1 &&
                std::abs(nearest->modes.front().frequency_hz - expected_hz) <= 1e-12,
            "GPU nearest-mode search differs from the exact positive branch");
    require(nearest->certified_inertia_factorizations == 5 && nearest->reused_inertia_probes == 5,
            "GPU nearest-mode search repeated the opening bracket's five certified cuDSS factor probes");
    problem.target_frequency_hz = 0.0;

    // Exercise the native diagnostics consumed by the modal publication gate.
    auto submitted = problem;
    submitted.assembly_kind = "mfem_weak_form_shared_domain";
    submitted.production_shared_domain = true;
    submitted.periodic_mesh_certificate_schema = "periodic_mesh_certificate.v6";
    submitted.robin_beta = 1.;
    submitted.gauge_reason = "coercive_outer_boundary";
    submitted.mesh_generation_identity = "publication-fixture-mesh";
    submitted.equilibrium_digest = "publication-fixture-equilibrium";
    submitted.bias_field_sample_signature = "publication-fixture-bias";
    submitted.boundary_gauge_digest = "publication-fixture-boundary";
    submitted.operator_input_digest = "publication-fixture-operator";
    submitted.target_frequency_hz = expected_hz * 1.02;
    const auto validate_publication = [&](const char *completeness, bool complete_window) {
        auto published = std::make_unique<fd::PoissonAirboxModalEigenResult>();
        require(fd::solve_poisson_airbox_modal_eigen_gpu_augmented_robin(submitted, .25, published.get()) ==
                    fd::FrequencyDomainStatus::ok,
                published->error_message);
        const char *diagnostics = published->diagnostics_json;
        require(std::strstr(diagnostics, "\"engine_id\":\"native_fem.frequency_domain.k0_poisson_airbox_gpu_augmented_cudss.v1\"") &&
                    std::strstr(diagnostics, "\"solve_succeeded\":true") &&
                    std::strstr(diagnostics, "\"fields_available\":true") &&
                    std::strstr(diagnostics, completeness) &&
                    std::strstr(diagnostics, complete_window ? "\"window_complete\":true" : "\"window_complete\":false") &&
                    published->window_complete == complete_window,
                "GPU augmented modal diagnostics lost required publication fields");
    };
    validate_publication("\"spectrum_completeness\":\"selected_only\"", false);
    submitted.target_kind = "frequency_window";
    submitted.frequency_min_hz = .1;
    submitted.frequency_max_hz = .8;
    validate_publication("\"spectrum_completeness\":\"certified_window\"", true);

#endif

    const auto paired = problem;
    constexpr std::array<double, 2> wrong_adjoint{-.75, -1.};
    problem.A_qphi = view(1, two_rows, vertical, wrong_adjoint);
    require(!fd::gpu::assemble_open_airbox_augmented_pencil(problem, 2., 6., 0.25),
            "nonreciprocal Poisson coupling accepted");
    problem = paired;
    --problem.B_qq.row_offsets_len;
    require(!fd::gpu::assemble_open_airbox_augmented_pencil(problem, 2., 6., 0.25), "truncated CSR accepted");
    problem = paired;
    problem.outer_boundary_kind = "pure_neumann";
    require(!fd::gpu::assemble_open_airbox_augmented_pencil(problem, 2., 6., 0.25), "different gauge accepted");
    require(!fd::gpu::assemble_open_airbox_augmented_pencil(paired, 2., std::numeric_limits<double>::infinity(), 0.25),
            "nonfinite shift accepted");
}

#include "core/petsc_slepc_runtime.hpp"
#include "cpu/frequency_domain/modal/floquet_modal_solver.hpp"
#include "cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp"
#include "cpu/frequency_domain/slepc_modal_eigen.hpp"

#ifndef FULLMAG_FEM_WITH_SLEPC
#define FULLMAG_FEM_WITH_SLEPC 0
#endif

#if FULLMAG_FEM_WITH_SLEPC
#include <mpi.h>
#include <slepceps.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <complex>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>

namespace fd = fullmag::fem::frequency_domain;
namespace runtime = fullmag::fem::runtime;

namespace {

int failures = 0;

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        ++failures;
    }
}

const char *text_or_empty(const char *value) noexcept
{
    return value != nullptr ? value : "";
}

bool same_text(const char *left, const char *right) noexcept
{
    return std::strcmp(text_or_empty(left), text_or_empty(right)) == 0;
}

bool close_enough(
    double left,
    double right,
    double absolute_tolerance,
    double relative_tolerance) noexcept
{
    if (!std::isfinite(left) || !std::isfinite(right)) {
        return false;
    }
    return std::abs(left - right) <= absolute_tolerance +
        relative_tolerance * std::max(std::abs(left), std::abs(right));
}

struct GammaFixture {
    std::array<double, 4> stiffness{{1.0, 0.0, 0.0, 1.0}};
    std::array<double, 4> gyrotropic{{0.0, -1.0, 1.0, 0.0}};
    std::array<double, 4> tangent_mass{{1.0, 0.0, 0.0, 1.0}};

    fd::SLEPcTinyGyrotropicModalEigenRequest request() const noexcept
    {
        fd::SLEPcTinyGyrotropicModalEigenRequest value{};
        value.tangent_dof_count = 2;
        value.stiffness_matrix_row_major = stiffness.data();
        value.gyrotropic_matrix_row_major = gyrotropic.data();
        value.tangent_mass_matrix_row_major = tangent_mass.data();
        value.requested_mode_count = 1;
        value.target_frequency_hz = 0.15915494309189535;
        value.frequency_min_hz = 0.1;
        value.frequency_max_hz = 0.2;
        value.residual_tolerance = 1.0e-10;
        value.max_outer_iterations = 64;
        value.max_linear_iterations = 128;
        return value;
    }
};

fd::PoissonAirboxSharedDomainComplexCsrMatrix diagonal_complex_csr(
    std::size_t dimension,
    const std::vector<std::complex<double>> &diagonal)
{
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

struct FloquetFixture {
    static constexpr std::size_t q_dimension = 8u;
    static constexpr double frequency_hz = 1.0e6;
    static constexpr double coupling = 0.25;

    fd::PoissonAirboxSharedDomainComplexCsrMatrix a_qq;
    fd::PoissonAirboxSharedDomainComplexCsrMatrix b_qq;
    fd::PoissonAirboxSharedDomainComplexCsrMatrix positive_tangent_mass;
    fd::PoissonAirboxSharedDomainComplexCsrMatrix p;
    fd::PoissonAirboxSharedDomainComplexCsrMatrix a_qphi;
    fd::PoissonAirboxSharedDomainComplexCsrMatrix a_phiq;

    FloquetFixture()
    {
        constexpr double coefficient_scale = 1.0e-60;
        const double balanced_coupling = std::sqrt(coefficient_scale) * coupling;
        std::vector<std::complex<double>> a_diagonal(q_dimension);
        std::vector<std::complex<double>> b_diagonal(
            q_dimension, std::complex<double>(0.0, -coefficient_scale));
        for (std::size_t row = 0u; row < q_dimension; ++row) {
            const double frequency = frequency_hz +
                2.0e5 * static_cast<double>(row);
            // With P=1, two Hermitian-balanced sqrt(scale)*c couplings
            // contribute scale*c^2 to the Schur product. The row-zero
            // diagonal includes exactly that term, leaving scale*omega.
            const double schur_correction = row == 0u
                ? coupling * coupling
                : 0.0;
            a_diagonal[row] = coefficient_scale *
                (fd::omega_rad_s_from_frequency_hz(frequency) + schur_correction);
        }

        a_qq = diagonal_complex_csr(q_dimension, a_diagonal);
        b_qq = diagonal_complex_csr(q_dimension, b_diagonal);
        positive_tangent_mass = diagonal_complex_csr(
            q_dimension,
            std::vector<std::complex<double>>(
                q_dimension, std::complex<double>(1.0, 0.0)));
        p = diagonal_complex_csr(1u, {std::complex<double>(1.0, 0.0)});
        a_qphi = q_to_phi_complex_csr(
            q_dimension, std::complex<double>(balanced_coupling, 0.0));
        a_phiq = phi_to_q_complex_csr(
            q_dimension, std::complex<double>(balanced_coupling, 0.0));
    }

    fd::FloquetSharedDomainSparseModalOperator operator_view() const noexcept
    {
        fd::FloquetSharedDomainSparseModalOperator value{};
        value.a_qq = &a_qq;
        value.b_qq = &b_qq;
        value.positive_tangent_mass = &positive_tangent_mass;
        value.p = &p;
        value.a_qphi = &a_qphi;
        value.a_phiq = &a_phiq;
        value.q_complex_dof_count = q_dimension;
        value.phi_dof_count = 1u;
        value.boundary_kind = "robin";
        value.gauge_policy = "nonzero_k_invertible_poisson";
        return value;
    }

    fd::SLEPcSparseGyrotropicModalEigenRequest request() const noexcept
    {
        fd::SLEPcSparseGyrotropicModalEigenRequest value{};
        value.tangent_dof_count = static_cast<int>(q_dimension);
        value.requested_mode_count = 1;
        // Keep the shift 10 kHz from the mode; the +100 Hz near-pole fixture
        // exercises a different numerical regime and is not needed here.
        value.target_frequency_hz = frequency_hz + 1.0e4;
        value.frequency_min_hz = 0.9 * frequency_hz;
        value.frequency_max_hz = 1.1 * frequency_hz;
        value.residual_tolerance = 1.0e-8;
        value.max_outer_iterations = 160;
        value.max_linear_iterations = 96;
        return value;
    }
};

void check_accepted_result(
    const fd::SLEPcTinyGyrotropicModalEigenResult &result,
    double residual_tolerance,
    const char *family)
{
    if (!result.ok) {
        std::fprintf(stderr,
                     "DIAG: %s status=%s reason=%s\n",
                     family,
                     text_or_empty(result.status),
                     text_or_empty(result.unsupported_reason));
    }
    check(result.ok, family);
    check(same_text(result.status, "ok"), "actual solver reports status=ok");
    check(!result.slepc_graph_quarantined,
          "successful solver call did not quarantine its PETSc graph");
    check(result.accepted_mode_count > 0 && !result.accepted_modes.empty(),
          "actual solver returns at least one accepted mode");
    check(static_cast<std::size_t>(result.accepted_mode_count) ==
              result.accepted_modes.size(),
          "accepted mode count matches returned modes");
    check(std::isfinite(result.frequency_hz) &&
              std::isfinite(result.relative_residual) &&
              result.relative_residual <= residual_tolerance,
          "actual solver returns finite accepted frequency and gated residual");
    for (const auto &mode : result.accepted_modes) {
        check(std::isfinite(mode.frequency_hz) &&
                  std::isfinite(mode.relative_residual) &&
                  mode.relative_residual <= residual_tolerance,
              "each accepted mode preserves the requested residual gate");
    }
}

void compare_result_to_baseline(
    const fd::SLEPcTinyGyrotropicModalEigenResult &baseline,
    const fd::SLEPcTinyGyrotropicModalEigenResult &observed,
    const char *family)
{
    check(observed.ok == baseline.ok,
          "concurrent solve preserves baseline success state");
    check(same_text(observed.status, baseline.status),
          "concurrent solve preserves baseline status");
    check(observed.accepted_mode_count == baseline.accepted_mode_count &&
              observed.accepted_modes.size() == baseline.accepted_modes.size(),
          "concurrent solve preserves baseline accepted-mode count");
    if (observed.ok && baseline.ok) {
        check(close_enough(
                  observed.frequency_hz, baseline.frequency_hz, 1.0e-8, 1.0e-10),
              family);
        check(close_enough(
                  observed.relative_residual,
                  baseline.relative_residual,
                  1.0e-12,
                  1.0e-6),
              "concurrent solve residual matches sequential baseline");
    }
    const std::size_t count = std::min(
        observed.accepted_modes.size(), baseline.accepted_modes.size());
    for (std::size_t index = 0u; index < count; ++index) {
        check(close_enough(
                  observed.accepted_modes[index].frequency_hz,
                  baseline.accepted_modes[index].frequency_hz,
                  1.0e-8,
                  1.0e-10),
              "accepted-mode frequency matches sequential baseline");
        check(close_enough(
                  observed.accepted_modes[index].relative_residual,
                  baseline.accepted_modes[index].relative_residual,
                  1.0e-12,
                  1.0e-6),
              "accepted-mode residual matches sequential baseline");
    }
}

struct WorkerResult {
    fd::SLEPcTinyGyrotropicModalEigenResult result{};
    bool threw = false;
};

void run_concurrent_round(
    const GammaFixture &gamma_fixture,
    const FloquetFixture &floquet_fixture,
    const fd::SLEPcTinyGyrotropicModalEigenResult &gamma_baseline,
    const fd::SLEPcTinyGyrotropicModalEigenResult &floquet_baseline)
{
    WorkerResult gamma_call{};
    WorkerResult floquet_call{};
    std::mutex observation_mutex;
    std::condition_variable observation_changed;
    std::size_t ready_count = 0u;
    std::size_t completed_count = 0u;
    bool start_calls = false;

    // Keep the actual shared operation boundary on the main thread while the
    // workers are released into both production entrypoints. The timed
    // no-completion observation is integration evidence only: it is not a
    // standalone mutex test. Source guards and valid post-release results are
    // checked separately by this contract.
    std::unique_lock<std::mutex> process_lock(
        runtime::petsc_slepc_process_mutex());

    const auto wait_for_release = [&]() {
        std::unique_lock<std::mutex> lock(observation_mutex);
        ++ready_count;
        observation_changed.notify_all();
        observation_changed.wait(lock, [&]() { return start_calls; });
    };
    const auto publish_completion = [&]() {
        {
            std::lock_guard<std::mutex> lock(observation_mutex);
            ++completed_count;
        }
        observation_changed.notify_all();
    };

    std::thread gamma_worker([&]() {
        wait_for_release();
        try {
            gamma_call.result = fd::solve_slepc_tiny_gyrotropic_modal_eigen(
                gamma_fixture.request());
        } catch (...) {
            gamma_call.threw = true;
        }
        publish_completion();
    });
    std::thread floquet_worker([&]() {
        wait_for_release();
        try {
            const auto operator_view = floquet_fixture.operator_view();
            floquet_call.result =
                fd::solve_floquet_shared_domain_sparse_modal_spectrum(
                    operator_view, floquet_fixture.request());
        } catch (...) {
            floquet_call.threw = true;
        }
        publish_completion();
    });

    std::unique_lock<std::mutex> observation_lock(observation_mutex);
    const bool workers_ready = observation_changed.wait_for(
        observation_lock,
        std::chrono::seconds(30),
        [&]() { return ready_count == 2u; });
    check(workers_ready,
          "both solver workers reach the synchronized start before calls begin");
    start_calls = true;
    observation_lock.unlock();
    observation_changed.notify_all();
    observation_lock.lock();
    const bool call_completed_while_main_owned_gate = observation_changed.wait_for(
        observation_lock,
        std::chrono::milliseconds(150),
        [&]() { return completed_count != 0u; });
    check(!call_completed_while_main_owned_gate && completed_count == 0u,
          "neither actual solver call completes during the bounded main-owned gate interval");
    observation_lock.unlock();

    process_lock.unlock();
    gamma_worker.join();
    floquet_worker.join();

    check(!gamma_call.threw && !floquet_call.threw,
          "concurrent solver workers complete without a C++ exception");
    check_accepted_result(
        gamma_call.result, 1.0e-10,
        "Gamma entrypoint succeeds after concurrent gate release");
    check_accepted_result(
        floquet_call.result, 1.0e-8,
        "native Floquet entrypoint succeeds after concurrent gate release");
    compare_result_to_baseline(
        gamma_baseline, gamma_call.result,
        "Gamma concurrent frequency matches sequential baseline");
    compare_result_to_baseline(
        floquet_baseline, floquet_call.result,
        "native Floquet concurrent frequency matches sequential baseline");
}

void preserve_unsafe_runtime_and_fail(const char *reason)
{
    std::fprintf(stderr,
                 "FAIL: refusing PETSc/SLEPc finalization with unsafe retained graph: %s\n",
                 reason);
    std::fflush(nullptr);
    std::_Exit(1);
}

void exit_if_process_unsafe(const char *reason)
{
    bool process_unsafe = false;
    {
        const std::lock_guard<std::mutex> lock(
            runtime::petsc_slepc_process_mutex());
        process_unsafe = runtime::petsc_slepc_process_is_unsafe_locked();
    }
    if (process_unsafe) {
        preserve_unsafe_runtime_and_fail(reason);
    }
}

void require_finalization_allowed_before_cleanup(const char *reason)
{
    bool finalization_allowed = false;
    {
        const std::lock_guard<std::mutex> lock(
            runtime::petsc_slepc_process_mutex());
        finalization_allowed =
            runtime::petsc_slepc_global_finalization_allowed_locked();
    }
    if (!finalization_allowed) {
        preserve_unsafe_runtime_and_fail(reason);
    }
}

} // namespace

int main(int argc, char **argv)
{
    int provided_thread_level = MPI_THREAD_SINGLE;
    const int mpi_init_error = MPI_Init_thread(
        &argc, &argv, MPI_THREAD_SERIALIZED, &provided_thread_level);
    if (mpi_init_error != MPI_SUCCESS) {
        std::fprintf(stderr, "FAIL: MPI_Init_thread failed with code %d\n", mpi_init_error);
        return 1;
    }
    if (provided_thread_level < MPI_THREAD_SERIALIZED) {
        std::fprintf(stderr,
                     "FAIL: MPI provided thread level %d, need at least MPI_THREAD_SERIALIZED\n",
                     provided_thread_level);
        MPI_Finalize();
        return 1;
    }

    const PetscErrorCode initialize_error =
        SlepcInitialize(&argc, &argv, nullptr, nullptr);
    if (initialize_error != 0) {
        std::fprintf(stderr,
                     "FAIL: main-thread SlepcInitialize failed with code %d\n",
                     static_cast<int>(initialize_error));
        MPI_Finalize();
        return 1;
    }

    const GammaFixture gamma_fixture{};
    const FloquetFixture floquet_fixture{};
    const auto gamma_baseline = fd::solve_slepc_tiny_gyrotropic_modal_eigen(
        gamma_fixture.request());
    exit_if_process_unsafe(
        "the sequential Gamma baseline quarantined the PETSc/SLEPc process");
    const auto floquet_operator = floquet_fixture.operator_view();
    const auto floquet_request = floquet_fixture.request();
    const auto floquet_baseline = fd::solve_floquet_shared_domain_sparse_modal_spectrum(
        floquet_operator, floquet_request);
    exit_if_process_unsafe(
        "the sequential native Floquet baseline quarantined the PETSc/SLEPc process");

    check_accepted_result(
        gamma_baseline, 1.0e-10,
        "sequential actual Gamma solve establishes a valid SLEPc baseline");
    check_accepted_result(
        floquet_baseline, 1.0e-8,
        "sequential actual native Floquet solve establishes a valid SLEPc baseline");
    require_finalization_allowed_before_cleanup(
        "one-shot Gamma/Floquet baselines left an unexpected retained solver graph");

    {
        fd::FloquetSharedDomainSparseModalSolveContext retained_floquet_context{};
        const auto retained_first =
            fd::solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context(
                floquet_operator, floquet_request, &retained_floquet_context);
        exit_if_process_unsafe(
            "the first retained-context solve quarantined the PETSc/SLEPc process");
        check_accepted_result(
            retained_first, 1.0e-8,
            "actual reusable native Floquet context returns an accepted result");
        compare_result_to_baseline(
            floquet_baseline, retained_first,
            "reusable native Floquet result matches sequential baseline");
        const auto retained_later =
            fd::solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context(
                floquet_operator, floquet_request, &retained_floquet_context);
        exit_if_process_unsafe(
            "a later reused-context solve quarantined the PETSc/SLEPc process");
        check_accepted_result(
            retained_later, 1.0e-8,
            "later actual reused-context Floquet call returns an accepted result");
        compare_result_to_baseline(
            floquet_baseline, retained_later,
            "later reused-context Floquet result matches sequential baseline");

        {
            const std::lock_guard<std::mutex> lock(
                runtime::petsc_slepc_process_mutex());
            check(runtime::petsc_slepc_has_live_cpu_graphs_locked(),
                  "attached reusable Floquet context registers its retained PETSc graph");
            check(!runtime::petsc_slepc_global_finalization_allowed_locked(),
                  "global PETSc/SLEPc finalization gate denies shutdown while context lives");
            check(!runtime::petsc_slepc_process_is_unsafe_locked(),
                  "retained reusable context is live without quarantining the process");
        }

        const auto gamma_with_retained_floquet =
            fd::solve_slepc_tiny_gyrotropic_modal_eigen(gamma_fixture.request());
        exit_if_process_unsafe(
            "Gamma use alongside a retained Floquet graph quarantined the process");
        check_accepted_result(
            gamma_with_retained_floquet, 1.0e-10,
            "Gamma entrypoint remains legal while a reusable Floquet graph is retained");
        compare_result_to_baseline(
            gamma_baseline, gamma_with_retained_floquet,
            "Gamma solve with retained Floquet context matches its baseline");

        for (int round = 0; round < 3; ++round) {
            run_concurrent_round(
                gamma_fixture,
                floquet_fixture,
                gamma_baseline,
                floquet_baseline);
            exit_if_process_unsafe(
                "an actual concurrent Gamma/Floquet call quarantined the process");
        }

        {
            const std::lock_guard<std::mutex> lock(
                runtime::petsc_slepc_process_mutex());
            check(runtime::petsc_slepc_has_live_cpu_graphs_locked(),
                  "later reused-context use retains the shared CPU graph");
            check(!runtime::petsc_slepc_global_finalization_allowed_locked(),
                  "finalization remains denied through later reused-context calls");
        }

        const bool checked_close_succeeded = retained_floquet_context.close();
        check(checked_close_succeeded,
              "explicit checked close reports successful retained-graph cleanup");
        if (!checked_close_succeeded) {
            preserve_unsafe_runtime_and_fail(
                "explicit retained-context cleanup failed; preserving the live graph");
        }
        {
            const std::lock_guard<std::mutex> lock(
                runtime::petsc_slepc_process_mutex());
            check(!runtime::petsc_slepc_has_live_cpu_graphs_locked(),
                  "checked close releases the retained CPU graph registration");
            check(runtime::petsc_slepc_global_finalization_allowed_locked(),
                  "checked close opens the shared finalization gate");
            if (!runtime::petsc_slepc_global_finalization_allowed_locked()) {
                preserve_unsafe_runtime_and_fail(
                    "checked close left the shared finalization gate closed");
            }
        }
    }

    {
        const std::lock_guard<std::mutex> lock(
            runtime::petsc_slepc_process_mutex());
        check(!runtime::petsc_slepc_has_live_cpu_graphs_locked(),
              "scope-exit destructor after checked close leaves no retained CPU graph");
        check(runtime::petsc_slepc_global_finalization_allowed_locked(),
              "scope-exit destructor after checked close preserves finalization availability");
        if (!runtime::petsc_slepc_global_finalization_allowed_locked()) {
            preserve_unsafe_runtime_and_fail(
                "retained graph fence remained active after public context destruction");
        }

        const PetscErrorCode finalize_error = SlepcFinalize();
        if (finalize_error != 0) {
            preserve_unsafe_runtime_and_fail(
                "SlepcFinalize failed after the shared finalization gate allowed shutdown");
        }
        PetscBool petsc_finalized = PETSC_FALSE;
        if (PetscFinalized(&petsc_finalized) != 0 ||
            petsc_finalized != PETSC_TRUE) {
            preserve_unsafe_runtime_and_fail(
                "SlepcFinalize did not leave PETSc in its terminal finalized state");
        }
    }

    const auto gamma_after_finalize = fd::solve_slepc_tiny_gyrotropic_modal_eigen(
        gamma_fixture.request());
    const auto floquet_after_finalize =
        fd::solve_floquet_shared_domain_sparse_modal_spectrum(
            floquet_operator, floquet_request);
    check(!gamma_after_finalize.ok &&
              same_text(gamma_after_finalize.status, "solve_error") &&
              same_text(gamma_after_finalize.unsupported_reason,
                        "petsc_runtime_finalized"),
          "actual Gamma entrypoint fails closed with typed finalized-runtime reason");
    check(!floquet_after_finalize.ok &&
              same_text(floquet_after_finalize.status, "solve_error") &&
              same_text(floquet_after_finalize.unsupported_reason,
                        "petsc_runtime_finalized"),
          "actual native Floquet entrypoint fails closed with typed finalized-runtime reason");

    const int mpi_finalize_error = MPI_Finalize();
    check(mpi_finalize_error == MPI_SUCCESS,
          "main thread finalizes MPI after all solver and post-finalization checks");
    if (failures != 0) {
        std::fprintf(stderr,
                     "FAIL: PETSc process runtime concurrency contract had %d failure(s)\n",
                     failures);
        return 1;
    }
    std::printf("PASS: PETSc process runtime Gamma/Floquet concurrency contract\n");
    return 0;
}

#else

int main()
{
    std::fprintf(stderr,
                 "FAIL: PETSc process runtime concurrency contract requires SLEPc\n");
    return 1;
}

#endif

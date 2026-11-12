#pragma once

#include "context.hpp"
#include "gpu/cuda/demag_poisson/demag_kernels.hpp"
#include "gpu/cuda/demag_poisson/hypre_device_solver.hpp"
#include "gpu/cuda/demag_poisson/hypre_stream_interop.hpp"
#include "gpu/cuda/runtime/performance_counters.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI) && FULLMAG_HAS_CUDA_RUNTIME
#include <HYPRE_utilities.h>
#include <cuda_runtime.h>

#include <array>
#include <cmath>
#include <cstdio>
#include <limits>
#include <string>

namespace fullmag::fem::test {

inline void check_gpu_hypre_demag_residual(
    void (*check)(bool, const char *),
    void (*check_stream_interop)(HypreStreamInterop &, std::string &) = nullptr)
{
    check(HYPRE_GetError() == 0,
          "strict GPU residual fixture requires a clean incoming HYPRE status");
    fullmag::fem::Context ctx;
    ctx.demag.solver.solver = FULLMAG_FEM_LINEAR_SOLVER_CG;
    ctx.demag.solver.preconditioner = FULLMAG_FEM_PRECONDITIONER_NONE;
    ctx.demag.solver.relative_tolerance = 1.0e-14;
    ctx.demag.solver.has_absolute_tolerance = 0;
    ctx.demag.solver.absolute_tolerance = 0.0;
    ctx.demag.solver.max_iterations = 1;
    ctx.demag.solver.print_level = 0;

    mfem::SparseMatrix op(8, 8);
    for (int i = 0; i < 8; ++i) {
        op.Add(i, i, 3.0 + static_cast<double>(i));
        if (i + 1 < 8) {
            op.Add(i, i + 1, -1.0);
            op.Add(i + 1, i, -1.0);
        }
    }
    op.Finalize();
    ctx.poisson_demag.poisson_bc_op = &op;
    ctx.gpu_state.device.demag_poisson.scalar_dof_count = 8;
    ctx.gpu_state.device.demag_poisson.full_scalar_dof_count = 8;
    check(cudaMalloc(
              reinterpret_cast<void **>(&ctx.gpu_state.device.demag_poisson.poisson_rhs),
              8 * sizeof(double)) == cudaSuccess,
          "strict GPU Hypre fixture allocates RHS");
    check(cudaMalloc(
              reinterpret_cast<void **>(&ctx.gpu_state.device.demag_poisson.poisson_solution),
              8 * sizeof(double)) == cudaSuccess,
          "strict GPU Hypre fixture allocates solution");

    fullmag::fem::GpuDemagPoissonWorkspace workspace;
    std::string error;
    check(fullmag::fem::initialize_demag_poisson_hypre_device_solver(ctx, workspace, error),
          "strict GPU Hypre one-iteration fixture initializes");
    *workspace.b_par = 1.0;
    *workspace.x_par = 0.0;
    workspace.b_par->HypreRead();
    workspace.x_par->HypreRead();
    check(fullmag::fem::initialize_hypre_stream_interop(workspace.stream_interop, error),
          "strict GPU fixture initializes exact HYPRE stream interop");
    workspace.solver->Mult(*workspace.b_par, *workspace.x_par);
    check(fullmag::fem::fullmag_wait_for_hypre(workspace.stream_interop, nullptr, error),
          "strict GPU fixture orders the solve before residual certification");
    check(HYPRE_GetError() == HYPRE_ERROR_CONV,
          "controlled one-iteration solve produces only the expected HYPRE convergence error");

    int iterations = -1;
    double residual = -1.0;
    auto &performance = ctx.gpu_state.performance_counters;
    auto &transfer = ctx.transfer_audit.audit;
    uint64_t step = 0;
    auto validate_candidate = [&](uint64_t expected_readbacks) {
        const auto perf_before = gpu_performance_snapshot(performance);
        const auto audit_before = transfer_audit_snapshot(transfer);
        gpu_performance_begin_attempt(performance, ++step);
        error.clear();
        bool accepted;
        {
            TransferAuditScope hot_loop(transfer, TransferAuditScopeKind::HotLoop);
            accepted = validate_demag_poisson_hypre_device_solve(
                ctx, workspace, iterations, residual, error);
        }
        if (accepted) {
            gpu_performance_commit_attempt(performance);
        } else {
            gpu_performance_fail_attempt(performance);
        }
        const auto perf_after = gpu_performance_snapshot(performance);
        const auto audit_after = transfer_audit_snapshot(transfer);
        const uint64_t bytes = expected_readbacks * sizeof(double);
        check(perf_after.physical_control_d2h_bytes -
                  perf_before.physical_control_d2h_bytes == bytes &&
                  perf_after.physical_control_fences -
                      perf_before.physical_control_fences == expected_readbacks,
              "strict GPU certification records physical control bytes and readback fences");
        check(audit_after.hot_loop_control_scalar_d2h_bytes -
                  audit_before.hot_loop_control_scalar_d2h_bytes == bytes &&
                  audit_after.hot_loop_control_scalar_host_sync_count -
                      audit_before.hot_loop_control_scalar_host_sync_count == expected_readbacks,
              "strict GPU certification classifies readbacks as hot-loop control transfers");
        return accepted;
    };
    const bool ok = validate_candidate(2);
    check(!ok, "strict GPU Hypre demag must reject a nonconverged one-iteration solve");
    check(error.find("solver_kind=gpu_poisson_hypre/cg") != std::string::npos,
          "strict GPU failure includes solver kind");
    check(error.find("iterations=1") != std::string::npos,
          "strict GPU failure includes iterations");
    check(error.find("residual=") != std::string::npos,
          "strict GPU failure includes residual");
    check(error.find("relative_tolerance=") != std::string::npos,
          "strict GPU failure includes tolerance");
    check(error.find("max_iterations=1") != std::string::npos,
          "strict GPU failure includes maximum iterations");

    // Keep the solver's recorded one-iteration nonconvergence and replace only
    // the device candidate and RHS to exercise independent certification.
    using FixtureVector = std::array<double, 8>;
    auto set_candidate = [&](const FixtureVector &x, const FixtureVector &b) {
        workspace.x_par->HypreWrite();
        workspace.b_par->HypreWrite();
        const cudaStream_t stream = workspace.stream_interop.hypre_stream;
        check(cudaMemcpyAsync(
                  ctx.gpu_state.device.demag_poisson.poisson_solution, x.data(),
                  x.size() * sizeof(double), cudaMemcpyHostToDevice, stream) == cudaSuccess &&
                  cudaMemcpyAsync(
                      ctx.gpu_state.device.demag_poisson.poisson_rhs, b.data(),
                      b.size() * sizeof(double), cudaMemcpyHostToDevice, stream) == cudaSuccess &&
                  cudaStreamSynchronize(stream) == cudaSuccess,
              "strict GPU residual fixture uploads candidate and RHS");
    };
    FixtureVector x;
    x.fill(1.0);
    // A * ones for the tridiagonal fixture above.
    const FixtureVector b{2.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 9.0};
    set_candidate(x, b);
    check(validate_candidate(2) && residual == 0.0,
          "strict GPU independent residual accepts the exact finite candidate");

    const double relative_offset = std::ldexp(1.0, -48);
    for (const int exponent : std::array{-665, 665}) {
        const double scale = std::ldexp(1.0, exponent);
        FixtureVector scaled_x;
        FixtureVector scaled_b;
        scaled_x.fill(scale);
        for (size_t i = 0; i < b.size(); ++i) {
            scaled_b[i] = b[i] * scale * (1.0 + relative_offset);
        }
        set_candidate(scaled_x, scaled_b);
        check(validate_candidate(2) && std::abs(residual - relative_offset) < 1.0e-28,
              "strict GPU scaled certification preserves a finite nonzero relative residual");
    }

    // A mismatched global size leaves the local SpMV unchanged on this serial
    // communicator, but HYPRE reports per-call status 12.
    set_candidate(x, b);
    auto *raw_residual = static_cast<hypre_ParVector *>(*workspace.residual);
    const auto original_global_size = hypre_ParVectorGlobalSize(raw_residual);
    hypre_ParVectorGlobalSize(raw_residual) = original_global_size + 1;
    const bool invalid_matvec_accepted = validate_candidate(1);
    hypre_ParVectorGlobalSize(raw_residual) = original_global_size;
    const bool invalid_matvec_rejected =
        !invalid_matvec_accepted && error.find("residual matvec") != std::string::npos &&
        error.find("HYPRE status 12") != std::string::npos;
    if (!invalid_matvec_rejected) {
        std::fprintf(stderr, "FAIL: certification accepted or misdiagnosed matvec status 12: %s\n",
                     error.c_str());
    }

    FixtureVector nonfinite;
    nonfinite.fill(std::numeric_limits<double>::quiet_NaN());
    set_candidate(nonfinite, b);
    const bool invalid_residual_rejected =
        !validate_candidate(2) && error.find("residual norm is nonfinite") != std::string::npos;
    if (!invalid_residual_rejected) {
        std::fprintf(stderr, "FAIL: certification accepted or misdiagnosed a NaN residual: %s\n",
                     error.c_str());
    }
    set_candidate(x, nonfinite);
    const bool invalid_rhs_rejected =
        !validate_candidate(1) && error.find("RHS norm is nonfinite") != std::string::npos;
    if (!invalid_rhs_rejected) {
        std::fprintf(stderr, "FAIL: certification accepted or misdiagnosed a NaN RHS: %s\n",
                     error.c_str());
    }
    check(invalid_matvec_rejected && invalid_residual_rejected && invalid_rhs_rejected,
          "strict GPU independent residual requires valid matvec, residual, and RHS");

    // The last element forces a second stride. The first element is both
    // an input and the device scalar output, as in residual certification.
    std::array<double, 257> strided_input{};
    const double scale = std::ldexp(1.0, 400);
    strided_input.front() = 3.0 * scale;
    strided_input.back() = 4.0 * scale;
    double *strided_device = nullptr;
    const size_t strided_bytes = strided_input.size() * sizeof(double);
    const cudaStream_t stream = workspace.stream_interop.hypre_stream;
    check(cudaMalloc(reinterpret_cast<void **>(&strided_device), strided_bytes) == cudaSuccess,
          "strict GPU norm fixture allocates a strided vector");
    check(cudaMemcpyAsync(strided_device, strided_input.data(), strided_bytes,
                          cudaMemcpyHostToDevice, stream) == cudaSuccess,
          "strict GPU norm fixture uploads the strided vector");
    double strided_norm = 0.0;
    const double expected_norm = 5.0 * scale;
    const double tolerance = 8.0 * std::numeric_limits<double>::epsilon() * expected_norm;
    check(fullmag_cuda_demag_validation_norm(
              strided_device, static_cast<int>(strided_input.size()),
              strided_device, strided_norm, stream) == cudaSuccess &&
              std::abs(strided_norm - expected_norm) <= tolerance,
          "strict GPU norm reduces a second stride when the result aliases the first input");
    check(cudaFree(strided_device) == cudaSuccess, "strict GPU norm fixture frees the strided vector");

    if (check_stream_interop != nullptr) {
        check_stream_interop(workspace.stream_interop, error);
    }
    fullmag::fem::destroy_hypre_stream_interop(workspace.stream_interop);
    workspace.solver.reset();
    workspace.preconditioner.reset();
    workspace.residual.reset();
    workspace.x_par.reset();
    workspace.b_par.reset();
    workspace.A_par.reset();
    check(cudaFree(ctx.gpu_state.device.demag_poisson.poisson_solution) == cudaSuccess,
          "strict GPU Hypre fixture frees solution");
    check(cudaFree(ctx.gpu_state.device.demag_poisson.poisson_rhs) == cudaSuccess,
          "strict GPU Hypre fixture frees RHS");
    ctx.gpu_state.device.demag_poisson.poisson_solution = nullptr;
    ctx.gpu_state.device.demag_poisson.poisson_rhs = nullptr;
    ctx.poisson_demag.poisson_bc_op = nullptr;
    // Keep the expected sticky bit throughout independent certification, then
    // consume only this fixture's error. Unexpected bits must fail before clear.
    check(HYPRE_GetError() == HYPRE_ERROR_CONV,
          "strict GPU residual fixture preserves only its expected convergence error through teardown");
    check(HYPRE_ClearError(HYPRE_ERROR_CONV) == 0,
          "strict GPU residual fixture consumes its expected convergence error");
    check(HYPRE_GetError() == 0,
          "strict GPU residual fixture leaves a clean HYPRE status for later owners");
}

} // namespace fullmag::fem::test
#endif

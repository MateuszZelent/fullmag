#pragma once
#include "backend_handle.hpp"
#include "gpu/cuda/demag_poisson/stage_compute.hpp"
#include "gpu/cuda/demag_poisson/operators.hpp"
#include "gpu/cuda/state/gpu_state.hpp"
#include "gpu/cuda/relaxation/direct_energy_increment.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include <vector>
#include <type_traits>
#include <utility>
#include <cmath>
#include <limits>

#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
namespace fullmag::fem::test {
static_assert(!std::is_copy_constructible_v<FemGpuPgbbPotentialPermit>);
static_assert(!std::is_copy_assignable_v<FemGpuPgbbPotentialPermit>);
static_assert(std::is_nothrow_move_constructible_v<FemGpuPgbbPotentialPermit>);
static_assert(std::is_nothrow_move_assignable_v<FemGpuPgbbPotentialPermit>);
inline void gpu_pgbb_accepted_potential_contract(fullmag_fem_backend *handle,
    double initial_energy, void (*check)(bool, const char *))
{
    auto download_m = [&] {
        std::vector<double> m;
        std::string reason;
        check(gpu_state_download_magnetization_aos(handle->context.gpu_state.device,
            m, handle->context.transfer_audit.audit, reason), reason.c_str());
        return m;
    };
    double previous_energy = initial_energy;
    auto check_proof = [&](double next_energy) {
        const auto &proof = handle->context.relaxation.accepted_energy_proof;
        check(proof.available && proof.delta_upper_j <= proof.armijo_rhs_j &&
            proof.armijo_rhs_j <= 0.0, "warm PGBB preserves strict accepted Armijo proof");
        const double slack = 32 * std::numeric_limits<double>::epsilon() *
            (std::abs(next_energy) + std::abs(previous_energy));
        check(std::abs((next_energy - previous_energy) - proof.delta_j) <=
            proof.roundoff_bound_j + slack, "warm accepted energy matches its Armijo proof");
        previous_energy = next_energy;
    };
    auto &ctx = handle->context;
    fullmag_fem_step_stats stats{};
    auto *ws = fullmag::fem::workspace_ptr(ctx);
    check(ws != nullptr, "PGBB warm fixture retains its Poisson workspace");
    check(ctx.gpu_state.device.relaxation.pgbb_accepted_potential.valid, "first cold step publishes accepted phi");
    for (unsigned step = 1; step < 2; ++step) {
        const auto warm_before = ws->warm_start_count;
        check(fullmag_fem_backend_relax_step(handle, FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB, &stats) == FULLMAG_FEM_OK,
            fullmag_fem_backend_last_error(handle));
        check_proof(stats.total_energy_joules);
        check(ctx.gpu_state.device.relaxation.pgbb_accepted_potential.valid,
            "ordinary fully finalized PGBB endpoint publishes accepted phi");
        check(ws->warm_start_count - warm_before == 1u,
            "cold PGBB step stays cold; next step warms exactly one first trial");
    }
    // Exercise production rollback paths with a real GPU trial solve.
    for (const auto failure : {fullmag::fem::GpuRelaxPgbbFailurePoint::AfterTrialField,
                              fullmag::fem::GpuRelaxPgbbFailurePoint::DuringAcceptedStatistics}) {
        const auto before_m = download_m();
        const auto before_steps = ctx.relaxation.accepted_steps;
        ctx.gpu_state.device.relaxation.next_pgbb_failure = failure;
        check(fullmag_fem_backend_relax_step(handle, FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB, &stats) != FULLMAG_FEM_OK,
            "injected native PGBB failure must reject the step");
        check(!ctx.gpu_state.device.relaxation.pgbb_accepted_potential.valid &&
            ctx.relaxation.accepted_steps == before_steps &&
            download_m() == before_m,
            "trial/finalizer failure restores m and metadata and invalidates phi");
        const auto warm_before = ws->warm_start_count;
        check(fullmag_fem_backend_relax_step(handle, FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB, &stats) == FULLMAG_FEM_OK,
            fullmag_fem_backend_last_error(handle));
        check(ws->warm_start_count == warm_before,
            "retry after rollback cannot reuse rejected phi");
        check_proof(stats.total_energy_joules);
    }
    const auto warm_before_reject = ws->warm_start_count;
    const auto cold_before_reject = ws->fresh_zero_guess_count;
    ctx.gpu_state.device.relaxation.next_pgbb_failure =
        fullmag::fem::GpuRelaxPgbbFailurePoint::RejectFirstTrial;
    check(fullmag_fem_backend_relax_step(handle, FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB, &stats) == FULLMAG_FEM_OK,
        fullmag_fem_backend_last_error(handle));
    check(stats.rejected_attempts >= 1 && ws->warm_start_count == warm_before_reject + 1 &&
        ws->fresh_zero_guess_count > cold_before_reject,
        "rejected first trial consumes accepted phi once; every backtrack solves fresh");
    check_proof(stats.total_energy_joules);
    auto *stream = ctx.gpu_state.cuda.compute_stream;
    std::string reason;
    auto &relax = ctx.gpu_state.device.relaxation;
    auto publish = [&] { fullmag::fem::gpu_demag_publish_pgbb_potential(ctx, stream);
        check(relax.pgbb_accepted_potential.valid, "native accepted endpoint is eligible"); };
    auto consume = [&] { return fullmag::fem::gpu_demag_consume_pgbb_potential(ctx, stream); };
    check(consume().valid && !consume().valid, "accepted potential cannot replay after consume");
    publish();
    const auto saved_fingerprint = ws->operator_fingerprint;
    ws->operator_fingerprint += "-changed";
    check(!consume().valid, "actual operator fingerprint mismatch refuses warm guess");
    ws->operator_fingerprint = saved_fingerprint;
    publish();
    ++ctx.relaxation.accepted_steps;
    check(!consume().valid, "accepted generation mismatch refuses warm guess");
    --ctx.relaxation.accepted_steps;
    publish();
    ++ctx.stage_completion.relax_torque_confirmation_count;
    check(!consume().valid, "torque confirmation cannot consume accepted guess");
    --ctx.stage_completion.relax_torque_confirmation_count;
    publish();
    fullmag::fem::gpu_relax_invalidate_accepted_evaluation(relax);
    check(!consume().valid, "shared rollback/error/upload invalidation kills phi token");
    publish();
    const auto saved_rows = ctx.gpu_state.device.demag_poisson.scalar_dof_count;
    ++ctx.gpu_state.device.demag_poisson.scalar_dof_count;
    check(!consume().valid, "resized layout cannot consume an old phi token");
    ctx.gpu_state.device.demag_poisson.scalar_dof_count = saved_rows;
    publish();
    const double ordinary_rtol = ctx.demag.solver.relative_tolerance;
    ctx.demag.solver.relative_tolerance *= 0.1;
    check(!consume().valid, "refinement solver policy cannot consume ordinary phi token");
    ctx.demag.solver.relative_tolerance = ordinary_rtol;
    publish();
    auto origin = consume();
    auto moved = std::move(origin);
    FemGpuPgbbPotentialPermit permit;
    permit = std::move(moved);
    check(permit.valid && !origin.valid && !moved.valid,
        "move construction and assignment transfer the sole execution authority");
    const auto warm_before_permit = ws->warm_start_count;
    check(compute_device_demag_for_pgbb_trial(ctx, ctx.gpu_state.device.magnetization.m,
        stream, permit, reason), reason.c_str());
    check(!permit.valid && ws->warm_start_count == warm_before_permit + 1,
        "last Poisson boundary consumes the permit before applying warm x");
    const auto cold_before_permit = ws->fresh_zero_guess_count;
    check(compute_device_demag_for_pgbb_trial(ctx, ctx.gpu_state.device.magnetization.m,
        stream, permit, reason), reason.c_str());
    check(ws->warm_start_count == warm_before_permit + 1 &&
        ws->fresh_zero_guess_count == cold_before_permit + 1,
        "replayed permit is a fresh GPU solve, never another warm apply");
    for (auto *spent : {&origin, &moved}) {
        check(compute_device_demag_for_pgbb_trial(ctx, ctx.gpu_state.device.magnetization.m,
            stream, *spent, reason), reason.c_str());
        check(!spent->valid && ws->warm_start_count == warm_before_permit + 1,
            "moved-from permit cannot authenticate the already overwritten trial phi");
    }
    check(ws->fresh_zero_guess_count == cold_before_permit + 3,
        "same-object replay and both moved-from permits each execute a fresh GPU solve");
    publish();
    check(!gpu_state_upload_magnetization_aos(ctx.gpu_state.device, nullptr,
        ctx.gpu_state.device.lifecycle.dof_len, ctx.transfer_audit.audit, reason) &&
        !consume().valid, "failed upload invalidates phi before any partial write");
    publish();
    check(gpu_state_resize_demag_poisson_scalars(ctx.gpu_state.device, saved_rows,
        ctx.gpu_state.device.demag_poisson.full_scalar_dof_count, reason) &&
        !consume().valid, "even a no-op resize fences the old potential token");
    publish();
    // Controlled ambiguous envelope drives the real refinement owner with two
    // identical physical endpoints. The recomputed zero delta cannot satisfy
    // the negative Armijo RHS; no synthetic scientific acceptance is published.
    GpuDirectArmijoResult refined{};
    refined.decision = relaxation::ArmijoDifferenceDecision::Refine;
    refined.difference.delta_joules = -2.0;
    refined.difference.roundoff_bound_joules = 2.0;
    refined.demag_roundoff_bound_j = 2.0;
    const auto warm_before_refinement = ws->warm_start_count;
    const auto ordinary_solver_rtol = ctx.demag.solver.relative_tolerance;
    const int n = static_cast<int>(ctx.gpu_state.device.lifecycle.node_count);
    check(gpu_direct_armijo_refine(ctx, reinterpret_cast<cudaStream_t>(stream),
        n, (n + 255) / 256, ctx.gpu_state.device.magnetization.m,
        ctx.gpu_state.device.magnetization.m, ctx.gpu_state.device.rk.error,
        -1.0, refined, reason), reason.c_str());
    check(refined.refinement_attempted && !refined.refinement_accepted &&
        refined.refinement_rhs_evaluations >= 2 &&
        ctx.demag.solver.relative_tolerance == ordinary_solver_rtol &&
        ws->warm_start_count == warm_before_refinement && !relax.pgbb_accepted_potential.valid,
        "real base/trial refinement stays fresh, restores policy, and invalidates phi");
    // The injected API failures intentionally terminate their stage. Start a
    // fresh confirmation stage rather than bypassing that terminal error.
    check(ctx.stage_completion.snapshot.has_reason != 0 &&
        ctx.stage_completion.snapshot.reason == FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
        "injected native failures retain their terminal backend-error reason");
    auto confirmation_stop = ctx.stage_completion.relax_stop;
    confirmation_stop.has_torque_tolerance_apm = 1;
    confirmation_stop.has_energy_tolerance_j = 0;
    confirmation_stop.torque_tolerance_apm = 1e300;
    initialize_stage_completion_state(ctx, confirmation_stop);
    const auto warm_before_confirmation = ws->warm_start_count;
    const auto accepted_before_confirmation = ctx.relaxation.accepted_steps;
    check(fullmag_fem_backend_relax_step(handle, FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB,
        &stats) == FULLMAG_FEM_OK, fullmag_fem_backend_last_error(handle));
    check(!relax.pgbb_accepted_potential.valid &&
        ws->warm_start_count == warm_before_confirmation &&
        ctx.relaxation.accepted_steps == accepted_before_confirmation,
        "real torque confirmation stays fresh and cannot publish accepted phi");
}
} // namespace fullmag::fem::test
#endif

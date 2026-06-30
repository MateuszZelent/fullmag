/*
 * Native FEM relaxation source-layout contract.
 *
 * Production FEM energy minimizers must live in backends/fem, not in Rust
 * runner reference/orchestration paths. Keep algorithm files split so BB, NCG,
 * and tangent-plane work can evolve without recreating a monolith.
 */

#include "source_facade_contract_utils.hpp"

#include <algorithm>

namespace {

using fullmag::fem::tests::check;
using fullmag::fem::tests::fem_source_root;
using fullmag::fem::tests::read_text_file;
using fullmag::fem::tests::repo_root;

std::size_t count_lines(const std::string &text) {
    return static_cast<std::size_t>(
               std::count(text.begin(), text.end(), '\n')) +
        (text.empty() || text.back() == '\n' ? 0u : 1u);
}

void native_relaxation_algorithms_live_under_mfem_relaxation() {
    const std::filesystem::path root = fem_source_root();
    const std::filesystem::path relaxation_root =
        root / "cpu" / "mfem" / "relaxation";

    check(
        std::filesystem::exists(relaxation_root / "relaxation_step.hpp"),
        "native FEM relaxation must expose a module-owned relaxation_step.hpp");
    check(
        std::filesystem::exists(relaxation_root / "relaxation_step.cpp"),
        "native FEM relaxation must own production minimizer step dispatch");
    check(
        std::filesystem::exists(relaxation_root / "relaxation_math.hpp") &&
            std::filesystem::exists(relaxation_root / "relaxation_math.cpp"),
        "native FEM relaxation must keep shared tangent-space math out of algorithm files");
    check(
        std::filesystem::exists(relaxation_root / "projected_gradient_bb.hpp") &&
            std::filesystem::exists(relaxation_root / "projected_gradient_bb.cpp"),
        "native FEM projected-gradient BB must live in dedicated algorithm files");
    check(
        std::filesystem::exists(relaxation_root / "nonlinear_cg.hpp") &&
            std::filesystem::exists(relaxation_root / "nonlinear_cg.cpp"),
        "native FEM nonlinear CG must live in dedicated algorithm files");
    check(
        std::filesystem::exists(relaxation_root / "tangent_plane_implicit.hpp") &&
            std::filesystem::exists(relaxation_root / "tangent_plane_implicit.cpp"),
        "native FEM tangent-plane implicit relaxation must have dedicated native files");
}

void c_abi_exposes_native_relaxation_step() {
    const std::filesystem::path root = fem_source_root();
    const std::string public_header =
        read_text_file(repo_root() / "native" / "include" / "fullmag_fem.h");
    const std::string api = read_text_file(root / "src" / "api.cpp");
    const std::string backend_step =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "backend_step.cpp");
    const std::string gpu_nonlinear_cg =
        read_text_file(root / "gpu" / "cuda" / "relaxation" / "nonlinear_cg.cpp");
    const std::string relaxation_step =
        read_text_file(root / "cpu" / "mfem" / "relaxation" / "relaxation_step.cpp");
    const std::string projected_gradient =
        read_text_file(root / "cpu" / "mfem" / "relaxation" / "projected_gradient_bb.cpp");
    const std::string nonlinear_cg =
        read_text_file(root / "cpu" / "mfem" / "relaxation" / "nonlinear_cg.cpp");
    const std::string relaxation_math =
        read_text_file(root / "cpu" / "mfem" / "relaxation" / "relaxation_math.cpp");
    const std::string tangent_plane =
        read_text_file(root / "cpu" / "mfem" / "relaxation" / "tangent_plane_implicit.cpp");
    const std::string mfem_context =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "mfem_context.cpp");
    const std::string demag =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag.cpp");
    const auto upload_snapshot_start =
        relaxation_math.find("int upload_and_snapshot(");
    const auto upload_snapshot_end =
        upload_snapshot_start == std::string::npos
            ? std::string::npos
            : relaxation_math.find("int restore_after_failed_line_search(", upload_snapshot_start);
    const std::string upload_and_snapshot =
        upload_snapshot_start == std::string::npos
            ? std::string()
            : relaxation_math.substr(
                  upload_snapshot_start,
                  upload_snapshot_end == std::string::npos
                      ? std::string::npos
                      : upload_snapshot_end - upload_snapshot_start);
    const auto upload_context_snapshot =
        upload_and_snapshot.find("context_snapshot_stats_mfem(ctx, stats, error)");
    const auto upload_state_validation =
        upload_and_snapshot.find("validate_relaxation_state_fields(ctx, algorithm_name, error)");
    const auto upload_energy_validation =
        upload_and_snapshot.find("validate_relaxation_step_energy(");
    const auto tangent_gradient_start =
        relaxation_math.find("void tangent_gradient_from_field(");
    const auto tangent_gradient_end =
        tangent_gradient_start == std::string::npos
            ? std::string::npos
            : relaxation_math.find("std::vector<double> project_tangent(", tangent_gradient_start);
    const std::string tangent_gradient =
        tangent_gradient_start == std::string::npos
            ? std::string()
            : relaxation_math.substr(
                  tangent_gradient_start,
                  tangent_gradient_end == std::string::npos
                      ? std::string::npos
                      : tangent_gradient_end - tangent_gradient_start);
    const auto project_tangent_start =
        relaxation_math.find("std::vector<double> project_tangent(");
    const auto project_tangent_end =
        project_tangent_start == std::string::npos
            ? std::string::npos
            : relaxation_math.find("std::vector<double> negative_field(", project_tangent_start);
    const std::string project_tangent =
        project_tangent_start == std::string::npos
            ? std::string()
            : relaxation_math.substr(
                  project_tangent_start,
                  project_tangent_end == std::string::npos
                      ? std::string::npos
                      : project_tangent_end - project_tangent_start);

    check(
        public_header.find("fullmag_fem_relax_algorithm") != std::string::npos,
        "C ABI must expose native FEM relaxation algorithm selection");
    check(
        public_header.find("fullmag_fem_backend_relax_step(") != std::string::npos,
        "C ABI must expose a native FEM relaxation step entrypoint");
    check(
        public_header.find("FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT") !=
            std::string::npos,
        "C ABI must expose a dedicated gradient-convergence stop reason for direct minimizers");
    check(
        api.find("fullmag::fem::run_backend_relaxation_step(") != std::string::npos,
        "api.cpp must delegate native relaxation step execution to runtime");
    check(
        backend_step.find("run_backend_relaxation_step(") != std::string::npos,
        "backend_step.cpp must own runtime delegation for native relaxation steps");
    check(
        backend_step.find("#include \"gpu/cuda/relaxation/pgbb.hpp\"") !=
                std::string::npos &&
            backend_step.find(
                "algorithm == FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB") !=
                std::string::npos &&
            backend_step.find("gpu_relax_projected_gradient_bb_step(") !=
                std::string::npos,
        "backend_step.cpp must route only allocated-GPU projected-gradient BB requests to the native GPU relaxation boundary");
    const auto gpu_relax_dispatch_start =
        backend_step.find("algorithm == FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB");
    const std::string gpu_relax_dispatch =
        gpu_relax_dispatch_start == std::string::npos
            ? std::string()
            : backend_step.substr(gpu_relax_dispatch_start);
    check(
        gpu_relax_dispatch.find("TransferAuditScope hot_loop") !=
                std::string::npos &&
            gpu_relax_dispatch.find("TransferAuditScopeKind::HotLoop") !=
                std::string::npos &&
            gpu_relax_dispatch.find("ctx.transfer_audit.audit.hot_loop_violation") !=
                std::string::npos &&
            gpu_relax_dispatch.find("ctx.transfer_audit.audit.hot_loop_violation_message") !=
                std::string::npos,
        "backend_step.cpp must wrap native GPU relaxation steps in transfer-audit hot-loop scope");
    check(
        backend_step.find("#include \"gpu/cuda/relaxation/nonlinear_cg.hpp\"") !=
                std::string::npos &&
            backend_step.find("algorithm == FULLMAG_FEM_RELAX_NONLINEAR_CG") !=
                std::string::npos &&
            backend_step.find("gpu_relax_nonlinear_cg_step(") !=
                std::string::npos,
        "backend_step.cpp must route allocated-GPU nonlinear CG requests to the native GPU relaxation boundary");
    check(
        gpu_nonlinear_cg.find("Routing remains disabled") == std::string::npos &&
            gpu_nonlinear_cg.find("unavailable stub") == std::string::npos,
        "native GPU nonlinear CG source contract must not describe the production CUDA lane as disabled or stubbed");
    check(
        relaxation_step.find("run_projected_gradient_bb_step(") != std::string::npos,
        "relaxation_step.cpp must route projected-gradient BB to the native algorithm module");
    check(
        relaxation_step.find("run_nonlinear_cg_step(") != std::string::npos,
        "relaxation_step.cpp must route nonlinear CG to the native algorithm module");
    check(
        projected_gradient.find("metric_dot_fields(") != std::string::npos &&
            projected_gradient.find("validate_tangent_gradient_field(") !=
                std::string::npos,
        "native FEM projected-gradient BB must use the FEM mass metric through shared gradient validation and descent products");
    check(
        relaxation_math.find("exchange_mass_preconditioned_gradient(") !=
                std::string::npos &&
            relaxation_math.find("assemble_exchange_mass_preconditioner(") !=
                std::string::npos &&
            relaxation_math.find("cached_exchange_mass_preconditioner(") !=
                std::string::npos &&
            relaxation_math.find("exchange_mass_preconditioner_weight == exchange_weight") !=
                std::string::npos &&
            relaxation_math.find("HypreBoomerAMG") != std::string::npos &&
            relaxation_math.find("HyprePCG") != std::string::npos,
        "native FEM direct minimizers must share a cached exchange-plus-mass Hypre-capable preconditioner");
    check(
        mfem_context.find("relaxation::destroy_exchange_mass_preconditioner_cache(ctx)") !=
            std::string::npos,
        "native FEM MFEM context teardown must destroy the direct-minimizer exchange-plus-mass preconditioner cache");
    check(
        relaxation_math.find("solver.GetConverged()") != std::string::npos &&
            relaxation_math.find("solver.GetFinalNorm()") != std::string::npos &&
            relaxation_math.find("direct FEM relaxation MFEM preconditioner solve did not converge") !=
                std::string::npos,
        "native FEM direct-minimizer serial MFEM preconditioner solves must reject non-converged linear solves");
    check(
        relaxation_math.find("validate_hypre_relative_residual(") !=
                std::string::npos &&
            relaxation_math.find("final_relative_residual <= kPreconditionerSolveRelativeTolerance") !=
                std::string::npos &&
            relaxation_math.find("final_absolute_residual <= kPreconditionerSolveAbsoluteTolerance") !=
                std::string::npos &&
            relaxation_math.find("direct FEM relaxation Hypre preconditioner requires OpenMPI singleton socket support") !=
                std::string::npos &&
            relaxation_math.find("iterations >= kPreconditionerSolveMaximumIterations") ==
                std::string::npos,
        "native FEM direct-minimizer Hypre preconditioner solves must reject non-converged residuals before using the solution");
    check(
        relaxation_math.find("validate_relaxation_state_fields(") !=
                std::string::npos &&
            relaxation_math.find("mfem_lumped_mass.size() != nodes") !=
                std::string::npos &&
            relaxation_math.find("magnetic_node_mask.size() != nodes") !=
                std::string::npos &&
            relaxation_math.find("requires at least one active magnetic node") !=
                std::string::npos,
        "native FEM direct minimizers must validate full FEM field dimensions and metric readiness before stepping");
    check(
        relaxation_math.find("double invalid_metric_value()") !=
                std::string::npos &&
            relaxation_math.find("std::numeric_limits<double>::quiet_NaN()") !=
                std::string::npos &&
            relaxation_math.find("a.size() != b.size()") !=
                std::string::npos &&
            relaxation_math.find("ctx.integration_weights.mfem_lumped_mass.size() != nodes") !=
                std::string::npos &&
            relaxation_math.find("ctx.mesh.magnetic_node_mask.size() != nodes") !=
                std::string::npos &&
            relaxation_math.find("!std::isfinite(mass) || mass <= 0.0") !=
                std::string::npos &&
            relaxation_math.find("return dot_fields(a, b);") ==
                std::string::npos &&
            relaxation_math.find("std::min(a.size(), b.size())") ==
                std::string::npos,
        "native FEM mass-metric helpers must reject invalid field dimensions instead of silently truncating or falling back to an unweighted dot product");
    check(
        relaxation_math.find("m_xyz.size() != direction_xyz.size()") !=
                std::string::npos &&
            relaxation_math.find("std::numeric_limits<double>::quiet_NaN()") !=
                std::string::npos &&
            relaxation_math.find("!std::isfinite(norm)") !=
                std::string::npos &&
            relaxation_math.find("norm <= 0.0") != std::string::npos &&
            relaxation_math.find("retracted_step(") != std::string::npos,
        "native FEM retraction must reject mismatched or invalid step directions before uploading a trial state");
    check(
        tangent_gradient.find("m_xyz.size() != h_eff_xyz.size()") !=
                std::string::npos &&
            tangent_gradient.find("m_xyz.size() % 3u != 0u") !=
                std::string::npos &&
            tangent_gradient.find("ctx.mesh.magnetic_node_mask.size() != m_xyz.size() / 3u") !=
                std::string::npos &&
            tangent_gradient.find("std::numeric_limits<double>::quiet_NaN()") !=
                std::string::npos,
        "native FEM tangent-gradient helper must reject mismatched H_eff/state dimensions before indexing field components");
    check(
        project_tangent.find("m_xyz.size() != vector_xyz.size()") !=
                std::string::npos &&
            project_tangent.find("m_xyz.size() % 3u != 0u") !=
                std::string::npos &&
            project_tangent.find("ctx.mesh.magnetic_node_mask.size() != m_xyz.size() / 3u") !=
                std::string::npos &&
            project_tangent.find("std::numeric_limits<double>::quiet_NaN()") !=
                std::string::npos,
        "native FEM tangent projection helper must reject mismatched vector/state dimensions before indexing field components");
    check(
        relaxation_math.find("validate_relaxation_step_energy(") !=
                std::string::npos &&
            relaxation_math.find("stats.total_energy_joules") !=
                std::string::npos &&
            relaxation_math.find("snapshot produced non-finite total energy") !=
                std::string::npos,
        "native FEM CPU direct minimizers must reject non-finite snapshot energies before Armijo or completion checks");
    check(
        relaxation_math.find("kMagnetizationUnitNormTolerance") !=
                std::string::npos &&
            relaxation_math.find("dot3(ctx.state.m_xyz, ctx.state.m_xyz, base)") !=
                std::string::npos &&
            relaxation_math.find("active magnetization is not unit length") !=
                std::string::npos,
        "native FEM CPU direct minimizer state validation must reject active magnetization vectors off the unit sphere");
    check(
        relaxation_math.find("validate_tangent_gradient_norm_sq(") !=
                std::string::npos &&
            relaxation_math.find("!std::isfinite(gradient_norm_sq)") !=
                std::string::npos &&
            relaxation_math.find("gradient_norm_sq < 0.0") !=
                std::string::npos &&
            relaxation_math.find("non-finite or negative tangent-gradient norm") !=
                std::string::npos,
        "native FEM CPU direct minimizers must reject invalid tangent-gradient norms before preconditioning or completion classification");
    check(
        relaxation_math.find("validate_tangent_gradient_field(") !=
                std::string::npos &&
            relaxation_math.find("tangent gradient size mismatch") !=
                std::string::npos &&
            relaxation_math.find("tangent gradient contains non-finite values") !=
                std::string::npos &&
            relaxation_math.find("metric_gradient_norm_sq(ctx, gradient_xyz)") !=
                std::string::npos &&
            relaxation_math.find("tangent gradient produced a non-finite or negative metric norm") !=
                std::string::npos,
        "native FEM CPU direct minimizers must validate tangent-gradient vectors and metric norms before storing algorithm state");
    check(
        upload_context_snapshot != std::string::npos &&
            upload_state_validation != std::string::npos &&
            upload_energy_validation != std::string::npos &&
            upload_context_snapshot < upload_state_validation &&
            upload_state_validation < upload_energy_validation,
        "native FEM CPU direct-minimizer snapshots must validate refreshed H_eff/state fields before Armijo energy checks or next-step gradients");
    check(
        relaxation_math.find("m_xyz.size() != ctx.state.m_xyz.size()") !=
                std::string::npos &&
            relaxation_math.find("magnetization size mismatch") !=
                std::string::npos &&
            relaxation_math.find("!all_finite(m_xyz)") !=
                std::string::npos &&
            relaxation_math.find("magnetization contains non-finite values") !=
                std::string::npos &&
            upload_and_snapshot.find("set_relaxation_magnetization_state(") !=
                std::string::npos &&
            upload_and_snapshot.find("!all_finite(m_xyz)") <
                upload_and_snapshot.find("set_relaxation_magnetization_state("),
        "native FEM CPU direct minimizers must reject invalid trial magnetization before setting trial state");
    check(
        relaxation_math.find("sanitized_relaxation_step_size(") !=
                std::string::npos &&
            relaxation_math.find("!std::isfinite(step_size)") !=
                std::string::npos &&
            relaxation_math.find("step_size <= 0.0") != std::string::npos &&
            relaxation_math.find("return kDefaultStepSize") !=
                std::string::npos &&
            relaxation_math.find("std::clamp(step_size, kMinStepSize, kMaxStepSize)") !=
                std::string::npos,
        "native FEM CPU direct minimizers must sanitize invalid runtime step sizes before retraction");
    check(
        projected_gradient.find("complete_stage_from_current_stats(ctx, current_stats)") !=
                std::string::npos &&
            nonlinear_cg.find("complete_stage_from_current_stats(ctx, current_stats)") !=
                std::string::npos &&
            tangent_plane.find("complete_stage_from_current_stats(ctx, current_stats)") !=
                std::string::npos,
        "native FEM CPU direct minimizers must classify already-satisfied stop criteria before taking another accepted step");
    check(
        relaxation_math.find("#include \"cpu/mfem/runtime/stage_completion.hpp\"") !=
                std::string::npos &&
            relaxation_math.find("update_stage_completion_from_stats(ctx, out_stats)") !=
                std::string::npos &&
            relaxation_math.find("finish_degenerate_gradient_relaxation_step(") !=
                std::string::npos &&
            relaxation_math.find("publish_accepted_gradient_completion(") !=
                std::string::npos &&
            relaxation_math.find("accepted_gradient_norm_sq <= kGradientFloor") !=
                std::string::npos &&
            relaxation_math.find("FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT") !=
                std::string::npos &&
            relaxation_math.find("\"tangent_gradient_norm_sq\"") !=
                std::string::npos,
        "native FEM CPU direct minimizers must publish accepted-step and gradient-converged stop state through the runtime stage-completion owner");
    check(
        relaxation_math.find("restore_previous_relaxation_state(") !=
                std::string::npos &&
            relaxation_math.find("restore_validated_relaxation_state(") !=
                std::string::npos &&
            relaxation_math.find(
                "validate_relaxation_state_fields(ctx, algorithm_name, restore_error)") !=
                std::string::npos &&
            relaxation_math.find("restore_after_rejected_trial(") !=
                std::string::npos &&
            relaxation_math.find("failed to restore previous state after") !=
                std::string::npos &&
            relaxation_math.find("original error:") != std::string::npos &&
            relaxation_math.find("error = original_error + \"; previous state restored\"") !=
                std::string::npos,
        "native FEM CPU direct minimizers must share checked and validated restore diagnostics for failed or rejected trial paths");
    check(
        projected_gradient.find("finish_degenerate_gradient_relaxation_step(") !=
                std::string::npos &&
            nonlinear_cg.find("finish_degenerate_gradient_relaxation_step(") !=
                std::string::npos &&
            tangent_plane.find("finish_degenerate_gradient_relaxation_step(") !=
                std::string::npos,
        "all native FEM CPU direct minimizers must publish gradient convergence instead of returning an unclassified no-op step");
    check(
        relaxation_math.find("bool take_cached_current_stats(") !=
                std::string::npos &&
            relaxation_math.find("ctx.relaxation.cached_current_stats_valid = false") !=
                std::string::npos &&
            relaxation_math.find("ctx.relaxation.cached_current_stats = trial_stats") !=
                std::string::npos &&
            relaxation_math.find("ctx.relaxation.cached_current_stats.wall_time_ns = 0") !=
                std::string::npos &&
            relaxation_math.find("ctx.relaxation.cached_current_stats.demag_solve_count = 0") !=
                std::string::npos,
        "native FEM CPU direct minimizers must cache accepted current stats without carrying old solve timings into the next step");
    check(
        projected_gradient.find("relaxation::take_cached_current_stats(ctx, current_stats)") !=
                std::string::npos &&
            nonlinear_cg.find("relaxation::take_cached_current_stats(ctx, current_stats)") !=
                std::string::npos &&
            tangent_plane.find("relaxation::take_cached_current_stats(ctx, current_stats)") !=
                std::string::npos,
        "all native FEM CPU direct minimizers must reuse accepted current stats before recomputing a fresh current snapshot");
    check(
        projected_gradient.find("validate_tangent_gradient_field(") !=
                std::string::npos &&
            projected_gradient.find("validate_tangent_gradient_field(") <
                projected_gradient.find("g_norm_sq <= relaxation::kGradientFloor"),
        "native FEM projected-gradient BB must reject invalid tangent-gradient vectors before gradient-completion classification");
    const auto pgbb_accepted_gradient_failure =
        projected_gradient.find("accepted-gradient validation failure");
    const auto pgbb_update_bb =
        projected_gradient.rfind("update_bb_step_size(");
    check(
        projected_gradient.find("\"accepted\"") != std::string::npos &&
            pgbb_accepted_gradient_failure != std::string::npos &&
            pgbb_update_bb != std::string::npos &&
            pgbb_accepted_gradient_failure < pgbb_update_bb &&
            projected_gradient.find("restore_previous_relaxation_state(") !=
                std::string::npos,
        "native FEM projected-gradient BB must validate accepted-step tangent gradients before BB state updates and restore on failure");
    check(
        projected_gradient.find("finish_accepted_relaxation_step(") !=
                std::string::npos &&
            projected_gradient.find("publish_accepted_gradient_completion(ctx, trial_g_norm_sq)") !=
                std::string::npos &&
            projected_gradient.find("finish_accepted_relaxation_step(") <
                projected_gradient.find("publish_accepted_gradient_completion(ctx, trial_g_norm_sq)"),
        "native FEM projected-gradient BB must publish accepted-step gradient completion from the validated accepted tangent-gradient norm");
    check(
        projected_gradient.find("restore_previous_relaxation_state(") !=
                std::string::npos &&
            projected_gradient.find("context_upload_magnetization_f64(") ==
                std::string::npos,
        "native FEM projected-gradient BB must not ignore restore failures after rejected or invalid trial states");
    check(
        projected_gradient.find("exchange_mass_preconditioned_gradient(") !=
                std::string::npos &&
            projected_gradient.find("direction_dot_gradient") != std::string::npos,
        "native FEM projected-gradient BB must use the preconditioned descent direction in Armijo");
    check(
        projected_gradient.find("!std::isfinite(direction_dot_gradient)") !=
                std::string::npos &&
            projected_gradient.find("non-finite or non-descent direction") !=
                std::string::npos,
        "native FEM projected-gradient BB must fail with explicit diagnostics for invalid descent directions");
    check(
        projected_gradient.find("validate_relaxation_state_fields(") !=
                std::string::npos,
        "native FEM projected-gradient BB must validate state fields before computing gradients");
    check(
        projected_gradient.find("validate_relaxation_step_energy(") !=
                std::string::npos &&
            projected_gradient.find("\"current\"") != std::string::npos &&
            projected_gradient.find("\"trial\"") != std::string::npos,
        "native FEM projected-gradient BB must validate current and trial snapshot energies explicitly");
    check(
        projected_gradient.find("sanitized_relaxation_step_size(ctx.relaxation.step_size)") !=
                std::string::npos,
        "native FEM projected-gradient BB must sanitize runtime step size before Armijo");
    check(
        relaxation_math.find("restore_after_failed_line_search(") !=
                std::string::npos &&
            projected_gradient.find("line_search_accepted") != std::string::npos &&
            projected_gradient.find("kProjectedGradientMaxBacktracks") !=
                std::string::npos &&
            projected_gradient.find("restore_after_failed_line_search(") !=
                std::string::npos,
        "native FEM projected-gradient BB must reject exhausted Armijo searches and restore the previous state");
    check(
        projected_gradient.find("retry_projected_gradient_bb_line_search_with_reset(") !=
                std::string::npos &&
            projected_gradient.find("kProjectedGradientArmijoRecoveryCycles") !=
                std::string::npos &&
            projected_gradient.find("accept_monotone_recovery_step(") !=
                std::string::npos &&
            projected_gradient.find("trial_step = restart_step;") !=
                std::string::npos &&
            projected_gradient.find("reset_consecutive") <
                projected_gradient.find("restore_after_failed_line_search("),
        "native FEM projected-gradient BB must attempt a bounded Armijo recovery with reset step-size policy, fresh restart step, and monotone fallback before failing the step");
    check(
        nonlinear_cg.find("not implemented yet") == std::string::npos,
        "native FEM nonlinear CG must not be an unavailable stub");
    check(
        nonlinear_cg.find("metric_dot_fields(") != std::string::npos &&
            nonlinear_cg.find("validate_tangent_gradient_field(") !=
                std::string::npos,
        "native FEM nonlinear CG must use the FEM mass metric through shared gradient validation and PR+ products");
    check(
        nonlinear_cg.find("validate_tangent_gradient_field(") !=
                std::string::npos &&
            nonlinear_cg.find("validate_tangent_gradient_field(") <
                nonlinear_cg.find("g_norm_sq <= relaxation::kGradientFloor"),
        "native FEM nonlinear CG must reject invalid tangent-gradient vectors before gradient-completion classification");
    check(
        nonlinear_cg.find("\"accepted\"") != std::string::npos &&
            nonlinear_cg.find("std::vector<double> trial_preconditioned_gradient;") !=
                std::string::npos &&
            nonlinear_cg.rfind("validate_tangent_gradient_field(") <
                nonlinear_cg.find("std::vector<double> trial_preconditioned_gradient;") &&
            nonlinear_cg.find("restore_previous_relaxation_state(") !=
                std::string::npos,
        "native FEM nonlinear CG must validate accepted-step tangent gradients before PR+ state updates and restore on failure");
    check(
        nonlinear_cg.find("finish_accepted_relaxation_step(") !=
                std::string::npos &&
            nonlinear_cg.find("publish_accepted_gradient_completion(ctx, trial_g_norm_sq)") !=
                std::string::npos &&
            nonlinear_cg.find("finish_accepted_relaxation_step(") <
                nonlinear_cg.find("publish_accepted_gradient_completion(ctx, trial_g_norm_sq)"),
        "native FEM nonlinear CG must publish accepted-step gradient completion from the validated accepted tangent-gradient norm");
    check(
        nonlinear_cg.find("restore_previous_relaxation_state(") !=
                std::string::npos &&
            nonlinear_cg.find("context_upload_magnetization_f64(") ==
                std::string::npos,
        "native FEM nonlinear CG must not ignore restore failures after rejected or invalid trial states");
    check(
        nonlinear_cg.find("previous_preconditioned_gradient") !=
                std::string::npos &&
            nonlinear_cg.find("trial_preconditioned_gradient") !=
                std::string::npos &&
            nonlinear_cg.find("exchange_mass_preconditioned_gradient(") !=
                std::string::npos,
        "native FEM nonlinear CG must use preconditioned Polak-Ribiere+ directions");
    check(
        nonlinear_cg.find("bool ensure_descent_direction(") !=
                std::string::npos &&
            nonlinear_cg.find("!std::isfinite(direction_dot_gradient)") !=
                std::string::npos &&
            nonlinear_cg.find("non-finite or non-descent direction") !=
                std::string::npos,
        "native FEM nonlinear CG must fail with explicit diagnostics for invalid descent directions");
    check(
        nonlinear_cg.find("validate_relaxation_state_fields(") !=
                std::string::npos,
        "native FEM nonlinear CG must validate state fields before computing gradients");
    check(
        nonlinear_cg.find("validate_relaxation_step_energy(") !=
                std::string::npos &&
            nonlinear_cg.find("\"current\"") != std::string::npos &&
            nonlinear_cg.find("\"trial\"") != std::string::npos,
        "native FEM nonlinear CG must validate current and trial snapshot energies explicitly");
    check(
        nonlinear_cg.find("sanitized_relaxation_step_size(ctx.relaxation.step_size)") !=
                std::string::npos,
        "native FEM nonlinear CG must sanitize runtime step size before Armijo");
    const std::size_t nonlinear_cg_trial_preconditioner_update =
        nonlinear_cg.find("std::vector<double> trial_preconditioned_gradient;");
    const std::size_t nonlinear_cg_accepted_step_finish =
        nonlinear_cg.find("finish_accepted_relaxation_step(");
    const std::string nonlinear_cg_trial_preconditioner_block =
        nonlinear_cg_trial_preconditioner_update == std::string::npos ||
            nonlinear_cg_accepted_step_finish == std::string::npos ||
            nonlinear_cg_trial_preconditioner_update >= nonlinear_cg_accepted_step_finish
        ? std::string{}
        : nonlinear_cg.substr(
              nonlinear_cg_trial_preconditioner_update,
              nonlinear_cg_accepted_step_finish -
                  nonlinear_cg_trial_preconditioner_update);
    check(
        nonlinear_cg_trial_preconditioner_block.find("trial_preconditioner_error") !=
                std::string::npos &&
            nonlinear_cg_trial_preconditioner_block.find(
                "accepted-step preconditioner update failure") !=
                std::string::npos &&
            nonlinear_cg_trial_preconditioner_block.find(
                "restore_previous_relaxation_state(") != std::string::npos &&
            nonlinear_cg_trial_preconditioner_block.find(
                "relaxation::negative_field(trial_gradient)") ==
                std::string::npos,
        "native FEM nonlinear CG must treat accepted-step preconditioner update failures as atomic restore errors instead of silently downgrading to raw steepest descent");
    check(
        nonlinear_cg.find("line_search_accepted") != std::string::npos &&
            nonlinear_cg.find("kNonlinearCgMaxBacktracks") !=
                std::string::npos &&
            nonlinear_cg.find("restore_after_failed_line_search(") !=
                std::string::npos,
        "native FEM nonlinear CG must reject exhausted Armijo searches and restore the previous state");
    check(
        nonlinear_cg.find("retry_nonlinear_cg_line_search_with_restart(") !=
                std::string::npos &&
            nonlinear_cg.find("retry_nonlinear_cg_line_search_with_raw_gradient_restart(") !=
                std::string::npos &&
            nonlinear_cg.find("kNonlinearCgArmijoRecoveryCycles") !=
                std::string::npos &&
            nonlinear_cg.find("kLineSearchEnergyNoiseFloorJ") !=
                std::string::npos &&
            nonlinear_cg.find("line_search_energy_tolerance(") !=
                std::string::npos &&
            nonlinear_cg.find("accept_monotone_recovery_step(") !=
                std::string::npos &&
            nonlinear_cg.find("trial_step = restart_step;") !=
                std::string::npos &&
            nonlinear_cg.find("relaxation::negative_field(previous_gradient)") !=
                std::string::npos &&
            nonlinear_cg.find("ctx.relaxation.nonlinear_cg_direction.clear()") <
                nonlinear_cg.find("restore_after_failed_line_search("),
        "native FEM nonlinear CG must attempt bounded Armijo recovery with restarted preconditioned and raw-gradient descent directions, fresh restart step, and monotone fallback before failing the step");
    check(
        relaxation_step.find("run_tangent_plane_implicit_step(") != std::string::npos,
        "relaxation_step.cpp must route tangent-plane implicit to the native algorithm module");
    check(
        tangent_plane.find("not implemented yet") == std::string::npos,
        "native FEM tangent-plane implicit relaxation must not be an unavailable stub");
    check(
        tangent_plane.find("metric_dot_fields(") != std::string::npos &&
            tangent_plane.find("validate_tangent_gradient_field(") !=
                std::string::npos,
        "native FEM tangent-plane implicit relaxation must use the FEM mass metric through shared gradient validation and tangent products");
    check(
        tangent_plane.find("validate_tangent_gradient_field(") !=
                std::string::npos &&
            tangent_plane.find("validate_tangent_gradient_field(") <
                tangent_plane.find("g_norm_sq <= relaxation::kGradientFloor"),
        "native FEM tangent-plane implicit relaxation must reject invalid tangent-gradient vectors before gradient-completion classification");
    check(
        tangent_plane.find("assemble_tangent_plane_operator(") != std::string::npos &&
            tangent_plane.find("solve_tangent_plane_linear_system(") != std::string::npos,
        "native FEM tangent-plane implicit relaxation must assemble and solve a global tangent-plane system");
    check(
        tangent_plane.find("mass_form->SpMat()") != std::string::npos &&
            tangent_plane.find("exchange_form->SpMat()") != std::string::npos,
        "native FEM tangent-plane implicit relaxation must use MFEM mass and exchange operators");
    check(
        tangent_plane.find("HyprePCG") != std::string::npos &&
            tangent_plane.find("HypreBoomerAMG") != std::string::npos,
        "native FEM tangent-plane implicit relaxation must use Hypre solver/preconditioner support when available");
    check(
        tangent_plane.find("add_local_anisotropy_tangent_hessian(") !=
                std::string::npos &&
            tangent_plane.find("add_uniaxial_anisotropy_jacobian(") !=
                std::string::npos &&
            tangent_plane.find("add_cubic_anisotropy_jacobian(") !=
                std::string::npos,
        "native FEM tangent-plane implicit relaxation must include local anisotropy curvature in the tangent operator");
    check(
        tangent_plane.find("add_local_zeeman_tangent_curvature(") !=
                std::string::npos &&
            tangent_plane.find("ctx.zeeman.h_ext_xyz") != std::string::npos &&
            tangent_plane.find("dot_array3(m, h_ext)") != std::string::npos,
        "native FEM tangent-plane implicit relaxation must include local Zeeman curvature in the tangent operator");
    check(
        tangent_plane.find("class MatrixFreeTangentPlaneOperator") != std::string::npos &&
            tangent_plane.find("compute_interfacial_dmi_field(") !=
                std::string::npos &&
            tangent_plane.find("compute_bulk_dmi_field(") != std::string::npos &&
            tangent_plane.find("solve_tangent_plane_matrix_free_system(") !=
                std::string::npos,
        "native FEM tangent-plane implicit relaxation must include DMI through a matrix-free weak-residual operator");
    check(
        tangent_plane.find("has_active_demag_tangent_operator(") !=
                std::string::npos &&
            tangent_plane.find("compute_fresh_demag_field_for_magnetization(") !=
                std::string::npos &&
            tangent_plane.find("ctx_.demag.h_xyz") != std::string::npos,
        "native FEM tangent-plane implicit relaxation must include demag through a fresh-solve matrix-free tangent operator");
    check(
        demag.find("compute_fresh_demag_field_for_magnetization(") !=
                std::string::npos &&
            demag.find("FreshDemagSolveSideEffects") != std::string::npos &&
            demag.find("demag_poisson_operator_ready_for_fresh_solve(") !=
                std::string::npos,
        "native FEM demag must expose a fresh-solve path for tangent-plane linear-response operators");
    check(
        tangent_plane.find("MINRESSolver") != std::string::npos &&
            tangent_plane.find("GMRESSolver") != std::string::npos &&
            tangent_plane.find("HypreGMRES") != std::string::npos &&
            tangent_plane.find("has_local_indefinite_terms") != std::string::npos,
        "native FEM tangent-plane implicit relaxation must use non-SPD-capable solvers for local and DMI curvature terms");
    check(
        tangent_plane.find("solver.GetConverged()") != std::string::npos &&
            tangent_plane.find("solver.GetFinalNorm()") != std::string::npos &&
            tangent_plane.find("tangent-plane implicit MFEM CG solve did not converge") !=
                std::string::npos &&
            tangent_plane.find("tangent-plane implicit MFEM MINRES solve did not converge") !=
                std::string::npos &&
            tangent_plane.find("tangent-plane implicit MFEM GMRES solve did not converge") !=
                std::string::npos,
        "native FEM tangent-plane implicit serial MFEM linear solves must reject non-converged solves");
    check(
        tangent_plane.find("validate_hypre_relative_residual(") !=
                std::string::npos &&
            tangent_plane.find("final_relative_residual <= kLinearSolveRelativeTolerance") !=
                std::string::npos &&
            tangent_plane.find("final_absolute_residual <= kLinearSolveAbsoluteTolerance") !=
                std::string::npos &&
            tangent_plane.find("tangent-plane implicit Hypre linear solve requires OpenMPI singleton socket support") !=
                std::string::npos &&
            tangent_plane.find("iterations >= kLinearSolveMaximumIterations") ==
                std::string::npos,
        "native FEM tangent-plane implicit Hypre linear solves must reject non-converged residuals before using the solution");
    check(
        tangent_plane.find("validate_relaxation_state_fields(") !=
                std::string::npos,
        "native FEM tangent-plane implicit relaxation must validate state fields before computing gradients");
    check(
        tangent_plane.find("validate_relaxation_step_energy(") !=
                std::string::npos &&
            tangent_plane.find("\"current\"") != std::string::npos &&
            tangent_plane.find("\"trial\"") != std::string::npos,
        "native FEM tangent-plane implicit relaxation must validate current and trial snapshot energies explicitly");
    check(
        tangent_plane.find("\"accepted\"") != std::string::npos &&
            tangent_plane.find("validate_tangent_gradient_field(") !=
                std::string::npos &&
            tangent_plane.find("accepted-gradient validation failure") !=
                std::string::npos &&
            tangent_plane.find("restore_previous_relaxation_state(") !=
                std::string::npos &&
            tangent_plane.rfind("validate_tangent_gradient_field(") <
                tangent_plane.find("update_implicit_step_size(ctx.relaxation, trial_step, backtracks)"),
        "native FEM tangent-plane implicit relaxation must validate accepted-step tangent gradients before storing accepted-step state");
    check(
        tangent_plane.find("sanitized_relaxation_step_size(ctx.relaxation.step_size)") !=
                std::string::npos,
        "native FEM tangent-plane implicit relaxation must sanitize runtime step size before Armijo");
    check(
        tangent_plane.find("projected direction contains non-finite values") !=
                std::string::npos &&
            tangent_plane.find("!std::isfinite(direction_dot_gradient)") !=
                std::string::npos &&
            tangent_plane.find("non-finite or non-descent tangent direction") !=
                std::string::npos,
        "native FEM tangent-plane implicit relaxation must fail with explicit diagnostics for invalid tangent directions");
    check(
        tangent_plane.find("line_search_accepted") != std::string::npos &&
            tangent_plane.find("kTangentPlaneImplicitMaxBacktracks") !=
                std::string::npos &&
            tangent_plane.find("restore_after_failed_line_search(") !=
                std::string::npos,
        "native FEM tangent-plane implicit relaxation must reject exhausted Armijo searches and restore the previous state");
    check(
        tangent_plane.find("restore_previous_relaxation_state(") !=
                std::string::npos &&
            tangent_plane.find("restore_after_rejected_trial(") !=
                std::string::npos &&
            tangent_plane.find("context_upload_magnetization_f64(") ==
                std::string::npos,
        "native FEM tangent-plane implicit relaxation must use shared validated restore helpers instead of direct state uploads after failed or rejected trial snapshots");
    check(
        tangent_plane.find("finish_accepted_relaxation_step(") !=
                std::string::npos &&
            tangent_plane.find("publish_accepted_gradient_completion(ctx, trial_g_norm_sq)") !=
                std::string::npos &&
            tangent_plane.find("finish_accepted_relaxation_step(") <
                tangent_plane.find("publish_accepted_gradient_completion(ctx, trial_g_norm_sq)"),
        "native FEM tangent-plane implicit relaxation must publish accepted-step gradient completion from the validated accepted tangent-gradient norm");
    check(
        tangent_plane.find("implicit_tangent_direction(") == std::string::npos &&
            tangent_plane.find("node_norm(") == std::string::npos,
        "native FEM tangent-plane implicit relaxation must not regress to a local diagonal step");
}

void runner_does_not_claim_production_fem_minimizer_ownership() {
    const std::string runner_fem =
        read_text_file(repo_root() / "crates" / "fullmag-runner" / "src" /
                       "fem" / "relax" / "direct_minimizer.rs");
    const std::string runner_algorithm =
        read_text_file(repo_root() / "crates" / "fullmag-runner" / "src" /
                       "fem" / "relax" / "algorithm.rs");

    check(
        runner_fem.find("backend.relax_step(") != std::string::npos,
        "runner FEM direct-minimizer path must call the native production relaxation ABI");
    check(
        runner_fem.find("backend.stage_completion()?") != std::string::npos &&
            runner_fem.find("backend_completion") != std::string::npos,
        "runner FEM direct-minimizer path must forward native stage-completion snapshots instead of inferring all stop reasons in Rust");
    check(
        runner_fem.find("relaxation_stop_criteria_satisfied") ==
                std::string::npos &&
            runner_fem.find("energy_plateau") == std::string::npos,
        "runner FEM direct-minimizer path must not duplicate native stop-state ownership with Rust-side plateau or stop checks");
    check(
        runner_fem.find("current_stats.max_torque_Apm <= threshold") ==
            std::string::npos,
        "runner FEM direct-minimizer path must not short-circuit native initial torque completion");
    check(
        runner_fem.find("bootstrap") == std::string::npos,
        "runner FEM direct-minimizer path must not describe native production relaxation as bootstrap");
    check(
        runner_fem.find("projected_gradient_line_search(") == std::string::npos &&
            runner_fem.find("nonlinear_cg_line_search(") == std::string::npos,
        "runner must not own production FEM direct-minimizer line-search loops");
    check(
        runner_algorithm.find("RelaxationAlgorithmIR::TangentPlaneImplicit => true") !=
            std::string::npos ||
            runner_algorithm.find("| RelaxationAlgorithmIR::TangentPlaneImplicit => Some(control)") !=
            std::string::npos,
        "runner must route tangent-plane implicit relaxation through the native FEM ABI");
}

void gpu_relaxation_pgbb_building_blocks_live_under_native_cuda() {
    const std::filesystem::path root = fem_source_root();
    const std::filesystem::path relaxation_root =
        root / "gpu" / "cuda" / "relaxation";
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string pgbb_header =
        read_text_file(relaxation_root / "pgbb.hpp");
    const std::string pgbb_source =
        read_text_file(relaxation_root / "pgbb.cpp");
    const std::string scalar_readback_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" /
                       "rk_scalar_readback.hpp");
    const std::string step_stats_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" /
                       "rk_step_stats.hpp");
    const std::string kernels_header =
        read_text_file(relaxation_root / "pgbb_kernels.hpp");
    const std::string kernels_source =
        read_text_file(relaxation_root / "pgbb_kernels.cu");
    const std::string gpu_demag_stage =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "stage_compute.cpp");
    const std::string runner_algorithm =
        read_text_file(repo_root() / "crates" / "fullmag-runner" / "src" /
                       "fem" / "relax" / "algorithm.rs");

    check(
        count_lines(pgbb_source) >= 550,
        "native FEM GPU projected-gradient BB must remain a full native CUDA implementation, not a thin routing shim");
    check(
        cmake.find("gpu/cuda/relaxation/pgbb.cpp") != std::string::npos &&
            cmake.find("gpu/cuda/relaxation/pgbb_kernels.cu") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB sources must be built by the native FEM CMake target");
    check(
        pgbb_header.find("gpu_relax_projected_gradient_bb_step(") !=
                std::string::npos &&
            pgbb_source.find("GPU CUDA projected-gradient BB relaxation step source contract") !=
                std::string::npos &&
            pgbb_source.find("gpu_relax_pgbb_preflight(") !=
                std::string::npos &&
            pgbb_source.find("gpu_rk_plan_device_resident(ctx, reason)") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must expose a native preflight/step boundary");
    check(
        pgbb_source.find("gpu.mesh_metrics.lumped_mass == nullptr") !=
                std::string::npos &&
            pgbb_source.find("GPU projected-gradient BB requires a device FEM lumped-mass metric") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB preflight must require the device FEM lumped-mass metric");
    check(
        pgbb_source.find("gpu.mesh_regions.magnetic_node_mask == nullptr") !=
                std::string::npos &&
            pgbb_source.find("gpu.mesh_regions.node_count != gpu.lifecycle.node_count") !=
                std::string::npos &&
            pgbb_source.find("GPU projected-gradient BB requires a device magnetic-node mask matching the FEM state") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB preflight must require a device magnetic-node mask matching the FEM state");
    check(
        pgbb_source.find("#include <limits>") != std::string::npos &&
            pgbb_source.find("std::numeric_limits<int>::max()") !=
                std::string::npos &&
            pgbb_source.find("GPU projected-gradient BB node count exceeds CUDA kernel launch index range") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB preflight must reject meshes too large for int-indexed CUDA kernels");
    check(
        pgbb_source.find("gpu.rk.m_backup.x == nullptr") !=
                std::string::npos &&
            pgbb_source.find("gpu.rk.m_backup.y == nullptr") !=
                std::string::npos &&
            pgbb_source.find("gpu.rk.m_backup.z == nullptr") !=
                std::string::npos &&
            pgbb_source.find("GPU projected-gradient BB requires RK backup scratch for rollback") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB preflight must require rollback backup scratch before line-search trials");
    check(
        pgbb_source.find("gpu_relax_compute_effective_field_and_energy(") !=
                std::string::npos &&
            pgbb_source.find("gpu_rk_compute_effective_field_for_magnetization(") !=
                std::string::npos &&
            pgbb_source.find("gpu_rk_compute_rhs_for_magnetization(") ==
                std::string::npos &&
            pgbb_source.find("fullmag_cuda_relax_retract_field(") !=
                std::string::npos &&
            pgbb_source.find("kArmijoCoefficient") != std::string::npos &&
            pgbb_source.find("trial_energy <=") != std::string::npos,
        "native FEM GPU projected-gradient BB must own a device-resident Armijo accepted-step loop");
    check(
        scalar_readback_header.find("gpu_rk_read_control_scalar_result(") !=
                std::string::npos &&
            scalar_readback_header.find("gpu_rk_read_control_scalar_results(") !=
                std::string::npos &&
            step_stats_header.find("gpu_rk_finalize_step_stats_control_readback(") !=
                std::string::npos,
        "native FEM GPU direct minimizers must have explicit control-scalar readback APIs separate from RK compute readbacks");
    check(
        pgbb_source.find("gpu_rk_read_control_scalar_results(") !=
                std::string::npos &&
            pgbb_source.find("gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)") !=
                std::string::npos &&
            pgbb_source.find("gpu_rk_read_control_scalar_result(") ==
                std::string::npos &&
            pgbb_source.find("gpu_rk_read_scalar_result(") ==
                std::string::npos &&
            pgbb_source.find("gpu_rk_read_scalar_results(") ==
                std::string::npos,
        "native FEM GPU projected-gradient BB must account scalar minimizer decisions as control readbacks, not compute D2H");
    check(
        pgbb_source.find("constexpr double kDefaultStepSize = 1.0e-6") !=
                std::string::npos &&
            pgbb_source.find("constexpr double kMinStepSize = 1.0e-15") !=
                std::string::npos &&
            pgbb_source.find("constexpr double kMaxStepSize = 1.0e-3") !=
                std::string::npos &&
            pgbb_source.find("constexpr double kArmijoCoefficient = 1.0e-4") !=
                std::string::npos &&
            pgbb_source.find("constexpr double kGradientFloor = 1.0e-30") !=
                std::string::npos &&
            pgbb_source.find("constexpr double kBbCurvatureScale = 1.0e-6") !=
                std::string::npos &&
            pgbb_source.find("constexpr double kLineSearchEnergyNoiseFloorJ = 1.0e-23") !=
                std::string::npos &&
            pgbb_source.find("constexpr double kLineSearchEnergyNoiseRelative = 1.0e-12") !=
                std::string::npos &&
            pgbb_source.find("constexpr uint32_t kMaxBacktracks = 20") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must keep CPU-compatible BB/Armijo constants until parity proof intentionally changes them");
    check(
        pgbb_source.find("double trial_step = kDefaultStepSize") !=
                std::string::npos &&
            pgbb_source.find("std::isfinite(ctx.relaxation.step_size)") !=
                std::string::npos &&
            pgbb_source.find("ctx.relaxation.step_size > 0.0") !=
                std::string::npos &&
            pgbb_source.find("std::clamp(ctx.relaxation.step_size, kMinStepSize, kMaxStepSize)") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must sanitize invalid runtime step sizes before retraction");
    check(
        pgbb_source.find("gpu_relax_compute_accepted_bb_curvature(") !=
                std::string::npos &&
            pgbb_source.find("fullmag_cuda_relax_bb_curvature_blocks(") !=
                std::string::npos &&
            pgbb_source.find("accepted curvature scalars device->host") !=
                std::string::npos &&
            pgbb_source.find("gpu_relax_apply_bb_step_size_from_curvature(") !=
                std::string::npos &&
            pgbb_source.find("ctx.relaxation.use_bb1") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must update BB1/BB2 step size from device-reduced curvature");
    check(
        pgbb_source.find("GPU projected-gradient BB produced non-finite total energy") !=
                std::string::npos &&
            pgbb_source.find("!std::isfinite(total_energy)") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must report non-finite energy failures explicitly");
    check(
        pgbb_source.find("GPU projected-gradient BB produced a non-finite or negative tangent-gradient norm") !=
                std::string::npos &&
            pgbb_source.find("!std::isfinite(gradient_norm_sq)") !=
                std::string::npos &&
            pgbb_source.find("gradient_norm_sq < 0.0") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must reject invalid tangent-gradient reductions before Armijo");
    check(
        pgbb_source.find("GPU projected-gradient BB produced invalid BB curvature scalars") !=
                std::string::npos &&
            pgbb_source.find("!std::isfinite(s_dot_s)") !=
                std::string::npos &&
            pgbb_source.find("!std::isfinite(s_dot_y)") !=
                std::string::npos &&
            pgbb_source.find("!std::isfinite(y_dot_y)") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must reject invalid BB curvature reductions before updating step size");
    check(
        pgbb_source.find("line_search_accepted") != std::string::npos &&
            pgbb_source.find("GPU projected-gradient BB failed Armijo line search") !=
                std::string::npos &&
            pgbb_source.find("gpu_relax_restore_previous_magnetization(") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must reject exhausted Armijo searches and restore the previous device state");
    check(
        pgbb_source.find("gpu_relax_retry_pgbb_line_search_with_reset(") !=
                std::string::npos &&
            pgbb_source.find("kArmijoRecoveryCycles") != std::string::npos &&
            pgbb_source.find("gpu_relax_accept_monotone_recovery_step(") !=
                std::string::npos &&
            pgbb_source.find("line_search_energy_tolerance(current_energy, trial_energy)") !=
                std::string::npos &&
            pgbb_source.find("trial_step = restart_step;") !=
                std::string::npos &&
            pgbb_source.find("reset_consecutive") <
                pgbb_source.find("GPU projected-gradient BB failed Armijo line search"),
        "native FEM GPU projected-gradient BB must attempt bounded Armijo recovery with reset step-size policy, fresh restart step, and noise-tolerant monotone fallback before failing the device step");
    const auto pgbb_first_armijo =
        pgbb_source.find("const bool armijo =", pgbb_source.find("while (true)"));
    check(
        pgbb_source.find("gpu_relax_accept_monotone_line_search_step(") !=
                std::string::npos &&
            pgbb_first_armijo != std::string::npos &&
            pgbb_source.find(
                "gpu_relax_accept_monotone_line_search_step(",
                pgbb_first_armijo) <
                pgbb_source.find("if (backtracks >= kMaxBacktracks)", pgbb_first_armijo),
        "native FEM GPU projected-gradient BB must accept noise-level monotone line-search trials before exhausting Armijo backtracks");
    check(
        pgbb_source.find("current_energy_j=") != std::string::npos &&
            pgbb_source.find("last_trial_energy_j=") != std::string::npos &&
            pgbb_source.find("armijo_rhs_j=") != std::string::npos &&
            pgbb_source.find("last_trial_step=") != std::string::npos &&
            pgbb_source.find("gradient_norm_sq=") != std::string::npos &&
            pgbb_source.find("format_gpu_relax_pgbb_scalar(") != std::string::npos,
        "native FEM GPU projected-gradient BB exhausted Armijo failures must include actionable scientific line-search diagnostics");
    check(
        pgbb_source.find("gpu_relax_restore_previous_magnetization_after_failure(") !=
                std::string::npos &&
            pgbb_source.find("failed to restore previous device state after") !=
                std::string::npos &&
            pgbb_source.find("original error:") != std::string::npos &&
            pgbb_source.find("previous device state restored") !=
                std::string::npos &&
            pgbb_source.find("(void)gpu_relax_restore_previous_magnetization(") ==
                std::string::npos,
        "native FEM GPU projected-gradient BB must check restore failures instead of masking them with best-effort device-state restore");
    check(
        pgbb_source.find("gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)") !=
                std::string::npos &&
            pgbb_source.find("FULLMAG_FEM_ERR_UNAVAILABLE") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must publish accepted stats while retaining no-CUDA unavailable fallback");
    check(
        pgbb_source.find("#include \"cpu/mfem/runtime/stage_completion.hpp\"") !=
                std::string::npos &&
            pgbb_source.find("FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT") !=
                std::string::npos &&
            pgbb_source.find("\"tangent_gradient_norm_sq\"") !=
                std::string::npos &&
            pgbb_source.find("set_stage_completion(") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must publish gradient-converged stop state through the runtime stage-completion owner");
    const auto pgbb_degenerate_gradient =
        pgbb_source.find("if (gradient_norm_sq <= kGradientFloor)");
    const auto pgbb_degenerate_finalize =
        pgbb_degenerate_gradient == std::string::npos
            ? std::string::npos
            : pgbb_source.find(
                  "gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)",
                  pgbb_degenerate_gradient);
    check(
        pgbb_source.find("void mark_gpu_relax_pgbb_device_source_of_truth(") !=
                std::string::npos &&
            pgbb_degenerate_gradient != std::string::npos &&
            pgbb_degenerate_finalize != std::string::npos &&
            pgbb_source.find(
                "mark_gpu_relax_pgbb_device_source_of_truth(ctx)",
                pgbb_degenerate_gradient) < pgbb_degenerate_finalize,
        "native FEM GPU projected-gradient BB must publish device source-of-truth before zero-gradient stats/stage completion");
    check(
        pgbb_source.find("gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)") !=
                std::string::npos &&
            pgbb_source.find("update_stage_completion_from_stats(ctx, out_stats)") !=
                std::string::npos &&
            pgbb_source.rfind("gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)") <
                pgbb_source.find("update_stage_completion_from_stats(ctx, out_stats)"),
        "native FEM GPU projected-gradient BB accepted steps must update runtime stage completion from finalized native stats");
    const std::size_t pgbb_accepted_finalize =
        pgbb_source.find("if (!gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason))");
    const std::size_t pgbb_accepted_finalize_restore =
        pgbb_accepted_finalize == std::string::npos
        ? std::string::npos
        : pgbb_source.find(
              "return gpu_relax_restore_accepted_step_after_finalize_failure(",
              pgbb_accepted_finalize);
    const std::size_t pgbb_stage_completion_update =
        pgbb_source.find("update_stage_completion_from_stats(ctx, out_stats)");
    check(
        pgbb_source.find("struct GpuRelaxPgbbRollbackState") !=
                std::string::npos &&
            pgbb_source.find("capture_gpu_relax_pgbb_rollback_state(ctx)") !=
                std::string::npos &&
            pgbb_source.find("restore_gpu_relax_pgbb_metadata(ctx, rollback)") !=
                std::string::npos &&
            pgbb_source.find("gpu_relax_restore_accepted_step_after_finalize_failure(") !=
                std::string::npos &&
            pgbb_source.find("accepted-step stats finalization failure") !=
                std::string::npos &&
            pgbb_source.find("capture_gpu_relax_pgbb_rollback_state(ctx)") <
                pgbb_source.find("ctx.relaxation.accepted_steps += 1") &&
            pgbb_accepted_finalize != std::string::npos &&
            pgbb_accepted_finalize_restore != std::string::npos &&
            pgbb_stage_completion_update != std::string::npos &&
            pgbb_accepted_finalize < pgbb_accepted_finalize_restore &&
            pgbb_accepted_finalize_restore < pgbb_stage_completion_update,
        "native FEM GPU projected-gradient BB must roll back device state and step metadata if accepted-step stats finalization fails");
    check(
        kernels_source.find("GPU CUDA projected-gradient BB relaxation kernels source contract") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB kernels must document their source contract");
    check(
        kernels_header.find("fullmag_cuda_relax_tangent_gradient_and_norm_blocks(") !=
                std::string::npos &&
            kernels_source.find("tangent_gradient_norm_kernel") !=
                std::string::npos &&
            kernels_source.find("const double grad_x = -tx") !=
                std::string::npos &&
            kernels_source.find("return mask[i] != 0u") !=
                std::string::npos &&
            kernels_source.find("mask == nullptr || mask[i] != 0u") ==
                std::string::npos,
        "native FEM GPU projected-gradient BB must expose CPU-compatible tangent-gradient kernels without all-active mask fallback");
    check(
        kernels_header.find("fullmag_cuda_relax_metric_dot_blocks(") !=
                std::string::npos &&
            kernels_source.find("node_weight(lumped_mass, i)") !=
                std::string::npos &&
            kernels_source.find("return lumped_mass[i]") !=
                std::string::npos &&
            kernels_source.find("lumped_mass == nullptr ? 1.0") ==
                std::string::npos &&
            kernels_source.find("block_reduce_sum(local)") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must expose FEM mass-metric reduction kernels without unweighted fallback");
    check(
        kernels_header.find("fullmag_cuda_relax_retract_field(") !=
                std::string::npos &&
            kernels_source.find("retract_field_kernel") != std::string::npos &&
            kernels_source.find("out_x[i] = x * inv") != std::string::npos &&
            kernels_source.find("!isfinite(norm)") != std::string::npos &&
            kernels_source.find("norm <= 0.0") != std::string::npos &&
            kernels_source.find("CUDART_NAN") != std::string::npos,
        "native FEM GPU projected-gradient BB must expose normalized nodal retraction kernels without invalid-norm no-op fallback");
    check(
        kernels_header.find("fullmag_cuda_relax_project_static_periodic_field(") !=
                std::string::npos &&
            kernels_source.find("project_static_periodic_field_kernel") !=
                std::string::npos &&
            kernels_source.find("periodic_representative_nodes[i]") !=
                std::string::npos &&
            pgbb_source.find("gpu.mesh_regions.has_periodic_reduced_nodes") !=
                std::string::npos &&
            pgbb_source.find("fullmag_cuda_relax_project_static_periodic_field(") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must project trial magnetization onto static periodic classes after retraction");
    check(
        gpu_demag_stage.find("#include \"gpu/cuda/relaxation/pgbb_kernels.hpp\"") !=
                std::string::npos &&
            gpu_demag_stage.find("gpu.mesh_regions.has_periodic_reduced_nodes") !=
                std::string::npos &&
            gpu_demag_stage.find("gpu.fields.h_demag.x") != std::string::npos &&
            gpu_demag_stage.find("fullmag_cuda_relax_project_static_periodic_field(") !=
                std::string::npos,
        "native FEM GPU Poisson demag must project recovered H_demag onto static periodic classes before energy/snapshots");
    const auto invalid_norm_branch =
        kernels_source.find("if (!isfinite(norm) || norm <= 0.0)");
    const auto normalized_branch = kernels_source.find("const double inv = 1.0 / norm");
    const std::string invalid_norm_retraction =
        invalid_norm_branch == std::string::npos ||
                normalized_branch == std::string::npos ||
                invalid_norm_branch >= normalized_branch
            ? std::string()
            : kernels_source.substr(
                  invalid_norm_branch,
                  normalized_branch - invalid_norm_branch);
    check(
        invalid_norm_retraction.find("CUDART_NAN") != std::string::npos &&
            invalid_norm_retraction.find("out_x[i] = mx[i]") ==
                std::string::npos &&
            invalid_norm_retraction.find("out_y[i] = my[i]") ==
                std::string::npos &&
            invalid_norm_retraction.find("out_z[i] = mz[i]") ==
                std::string::npos,
        "native FEM GPU projected-gradient BB invalid-norm retraction branch must write NaNs instead of restoring the previous active vector");
    check(
        kernels_header.find("fullmag_cuda_relax_bb_curvature_blocks(") !=
                std::string::npos &&
            kernels_source.find("bb_curvature_kernel") !=
                std::string::npos &&
            kernels_source.find("block_s_dot_s[blockIdx.x]") !=
                std::string::npos &&
            kernels_source.find("block_s_dot_y[blockIdx.x]") !=
                std::string::npos &&
            kernels_source.find("block_y_dot_y[blockIdx.x]") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must expose device BB curvature reduction kernels");
    check(
        runner_algorithm.find("ProjectedGradientBb, FemEngineKind::NativeGpu) => true") !=
                std::string::npos &&
            runner_algorithm.find("NonlinearCg, FemEngineKind::NativeGpu) => true") !=
                std::string::npos &&
            runner_algorithm.find("TangentPlaneImplicit, FemEngineKind::NativeGpu) => false") !=
                std::string::npos,
        "runner must advertise native GPU projected-gradient BB and nonlinear-CG while keeping TPI CPU-only");
}

void gpu_relaxation_ncg_direction_state_is_device_persistent() {
    const std::filesystem::path root = fem_source_root();
    const std::filesystem::path relaxation_root =
        root / "gpu" / "cuda" / "relaxation";
    const std::filesystem::path state_root = root / "gpu" / "cuda" / "state";
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string backend_step =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "backend_step.cpp");
    const std::string ncg_header =
        read_text_file(relaxation_root / "nonlinear_cg.hpp");
    const std::string ncg_source =
        read_text_file(relaxation_root / "nonlinear_cg.cpp");
    const std::string scalar_readback_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" /
                       "rk_scalar_readback.hpp");
    const std::string step_stats_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" /
                       "rk_step_stats.hpp");
    const std::string kernels_header =
        read_text_file(relaxation_root / "pgbb_kernels.hpp");
    const std::string kernels_source =
        read_text_file(relaxation_root / "pgbb_kernels.cu");
    const std::string relaxation_state =
        read_text_file(relaxation_root / "relaxation_state.hpp");
    const std::string relaxation_memory_header =
        read_text_file(relaxation_root / "relaxation_memory.hpp");
    const std::string relaxation_memory_source =
        read_text_file(relaxation_root / "relaxation_memory.cpp");
    const std::string gpu_state_header =
        read_text_file(state_root / "gpu_state.hpp");
    const std::string gpu_state_source =
        read_text_file(state_root / "gpu_state.cpp");

    check(
        count_lines(ncg_source) >= 700,
        "native FEM GPU nonlinear-CG must remain a full native CUDA implementation, not a thin routing shim");
    check(
        cmake.find("gpu/cuda/relaxation/relaxation_memory.cpp") !=
                std::string::npos &&
            cmake.find("gpu/cuda/relaxation/nonlinear_cg.cpp") !=
                std::string::npos &&
            cmake.find("gpu/cuda/relaxation/pgbb_kernels.cu") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG source, kernels, and persistent relaxation memory must be built by the native FEM CMake target");
    check(
        backend_step.find("#include \"gpu/cuda/relaxation/nonlinear_cg.hpp\"") !=
                std::string::npos &&
            backend_step.find("algorithm == FULLMAG_FEM_RELAX_NONLINEAR_CG") !=
                std::string::npos &&
            backend_step.find("gpu_relax_nonlinear_cg_step(ctx, out_stats, error)") !=
                std::string::npos,
        "native FEM backend-step routing must dispatch allocated GPU nonlinear-CG to the native CUDA relaxation step");
    check(
        ncg_header.find("gpu_relax_nonlinear_cg_step(") !=
                std::string::npos &&
            ncg_source.find("GPU CUDA nonlinear-CG relaxation step source contract") !=
                std::string::npos &&
            ncg_source.find("gpu_relax_ncg_preflight(") !=
                std::string::npos &&
            ncg_source.find("gpu_rk_plan_device_resident(ctx, reason)") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG must expose a native preflight/step boundary");
    check(
        ncg_source.find("#include <limits>") != std::string::npos &&
            ncg_source.find("std::numeric_limits<int>::max()") !=
                std::string::npos &&
            ncg_source.find("GPU nonlinear-CG node count exceeds CUDA kernel launch index range") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG preflight must reject meshes too large for int-indexed CUDA kernels");
    check(
        ncg_source.find("gpu_relax_compute_effective_field_and_energy(") !=
                std::string::npos &&
            ncg_source.find("gpu_rk_compute_effective_field_for_magnetization(") !=
                std::string::npos &&
            ncg_source.find("gpu_rk_compute_rhs_for_magnetization(") ==
                std::string::npos &&
            ncg_source.find("gpu_relax_prepare_descent_direction(") !=
                std::string::npos &&
            ncg_source.find("gpu_relax_update_next_direction(") !=
                std::string::npos &&
            ncg_source.find("fullmag_cuda_relax_retract_field(") !=
                std::string::npos &&
            ncg_source.find("gpu.mesh_regions.has_periodic_reduced_nodes") !=
                std::string::npos &&
            ncg_source.find("fullmag_cuda_relax_project_static_periodic_field(") !=
                std::string::npos &&
            ncg_source.find("kArmijoCoefficient") != std::string::npos &&
            ncg_source.find("trial_energy <=") != std::string::npos,
        "native FEM GPU nonlinear-CG must own a device-resident Armijo/PR+ accepted-step loop with static periodic trial projection");
    check(
        scalar_readback_header.find("gpu_rk_read_control_scalar_result(") !=
                std::string::npos &&
            scalar_readback_header.find("gpu_rk_read_control_scalar_results(") !=
                std::string::npos &&
            step_stats_header.find("gpu_rk_finalize_step_stats_control_readback(") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG must use explicit control-scalar readback APIs separate from RK compute readbacks");
    check(
        ncg_source.find("gpu_rk_read_control_scalar_result(") !=
                std::string::npos &&
            ncg_source.find("gpu_rk_read_control_scalar_results(") !=
                std::string::npos &&
            ncg_source.find("gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)") !=
                std::string::npos &&
            ncg_source.find("gpu_rk_read_scalar_result(") ==
                std::string::npos &&
            ncg_source.find("gpu_rk_read_scalar_results(") ==
                std::string::npos,
        "native FEM GPU nonlinear-CG must account scalar minimizer decisions as control readbacks, not compute D2H");
    check(
        ncg_source.find("gpu_relax_compute_effective_field_energy_gradient_and_direction(") !=
                std::string::npos &&
            ncg_source.find("fullmag_cuda_relax_ncg_gradient_direction_and_norm_blocks(") !=
                std::string::npos &&
            ncg_source.find("current energy/gradient/direction scalars device->host") !=
                std::string::npos &&
            ncg_source.find("double scalars[4]") != std::string::npos &&
            ncg_source.find("reset_descent_direction") != std::string::npos &&
            ncg_source.find("gpu_relax_prepare_descent_direction(") !=
                std::string::npos &&
            ncg_source.find("fullmag_cuda_relax_ncg_reset_direction_if_not_descent(") !=
                std::string::npos &&
            ncg_source.find("reset direction scalars device->host") ==
                std::string::npos,
        "native FEM GPU nonlinear-CG must batch current energy, gradient norm, and descent-direction scalars while keeping reset fallback device-side");
    check(
        ncg_source.find("kNcgScalarTailCount = 2") != std::string::npos &&
            ncg_source.find("fullmag_cuda_relax_ncg_update_direction_from_reduced_pr_plus(") !=
                std::string::npos &&
            ncg_source.find("gpu_rk_finalize_step_stats_control_readback_with_scalar_tail(") !=
                std::string::npos &&
            ncg_source.find("accepted gradient/PR+ scalars device->host") ==
                std::string::npos &&
            ncg_source.find("accepted-step gradient validation failure") !=
                std::string::npos &&
            ncg_source.find("accepted-step PR+ validation failure") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG must fold accepted PR+ validation into the final control readback instead of adding a separate host sync");
    check(
        ncg_source.find("constexpr double kDefaultStepSize = 1.0e-6") !=
                std::string::npos &&
            ncg_source.find("constexpr double kMinStepSize = 1.0e-15") !=
                std::string::npos &&
            ncg_source.find("constexpr double kMaxStepSize = 1.0e-3") !=
                std::string::npos &&
            ncg_source.find("constexpr double kArmijoCoefficient = 1.0e-4") !=
                std::string::npos &&
            ncg_source.find("constexpr double kGradientFloor = 1.0e-30") !=
                std::string::npos &&
            ncg_source.find("constexpr double kLineSearchEnergyNoiseFloorJ = 1.0e-23") !=
                std::string::npos &&
            ncg_source.find("constexpr double kLineSearchEnergyNoiseRelative = 1.0e-12") !=
                std::string::npos &&
            ncg_source.find("constexpr uint32_t kMaxBacktracks = 30") !=
                std::string::npos &&
            ncg_source.find("constexpr uint64_t kRestartInterval = 50") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG must keep explicit Armijo/gradient/restart constants until parity proof intentionally changes them");
    check(
        ncg_source.find("gpu.mesh_metrics.lumped_mass == nullptr") !=
                std::string::npos &&
            ncg_source.find("GPU nonlinear-CG requires a device FEM lumped-mass metric") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG preflight must require the device FEM lumped-mass metric");
    check(
        ncg_source.find("gpu.mesh_regions.magnetic_node_mask == nullptr") !=
                std::string::npos &&
            ncg_source.find("gpu.mesh_regions.node_count != gpu.lifecycle.node_count") !=
                std::string::npos &&
            ncg_source.find("GPU nonlinear-CG requires a device magnetic-node mask matching the FEM state") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG preflight must require a device magnetic-node mask matching the FEM state");
    check(
        ncg_source.find("gpu.relaxation.node_count != gpu.lifecycle.node_count") !=
                std::string::npos &&
            ncg_source.find("GPU nonlinear-CG requires persistent device search-direction state") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG preflight must require persistent device search-direction state matching the FEM state");
    check(
        ncg_source.find("gpu_relax_retry_ncg_line_search_with_restart(") !=
                std::string::npos &&
            ncg_source.find("kArmijoRecoveryCycles") != std::string::npos &&
            ncg_source.find("gpu_relax_accept_monotone_recovery_step(") !=
                std::string::npos &&
            ncg_source.find("line_search_energy_tolerance(current_energy, trial_energy)") !=
                std::string::npos &&
            ncg_source.find("trial_step = restart_step;") !=
                std::string::npos &&
            ncg_source.find("gpu.relaxation.nonlinear_cg_direction_valid = false") <
                ncg_source.find("GPU nonlinear-CG failed Armijo line search"),
        "native FEM GPU nonlinear-CG must attempt bounded Armijo recovery with restarted descent direction, fresh restart step, and noise-tolerant monotone fallback before failing the device step");
    check(
        ncg_source.find("current_energy_j=") != std::string::npos &&
            ncg_source.find("last_trial_energy_j=") != std::string::npos &&
            ncg_source.find("armijo_rhs_j=") != std::string::npos &&
            ncg_source.find("last_trial_step=") != std::string::npos &&
            ncg_source.find("direction_dot_gradient=") != std::string::npos &&
            ncg_source.find("gradient_norm_sq=") != std::string::npos,
        "native FEM GPU nonlinear-CG exhausted Armijo failures must include actionable line-search diagnostics");
    check(
        ncg_source.find("GPU nonlinear-CG produced non-finite total energy") !=
                std::string::npos &&
            ncg_source.find("!std::isfinite(total_energy)") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG must report non-finite energy failures explicitly");
    check(
        ncg_source.find("GPU nonlinear-CG produced a non-finite or negative tangent-gradient norm") !=
                std::string::npos &&
            ncg_source.find("!std::isfinite(gradient_norm_sq)") !=
                std::string::npos &&
            ncg_source.find("gradient_norm_sq < 0.0") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG must reject invalid tangent-gradient reductions before Armijo");
    check(
        ncg_source.find("GPU nonlinear-CG produced a non-finite or non-descent direction") !=
                std::string::npos &&
            ncg_source.find("!std::isfinite(p_dot_g)") !=
                std::string::npos &&
            ncg_source.find("p_dot_g >= 0.0") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG must reject invalid or non-descent search directions before line search");
    check(
        ncg_source.find("gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)") !=
                std::string::npos &&
            ncg_source.find("update_stage_completion_from_stats(ctx, out_stats)") !=
                std::string::npos &&
            ncg_source.rfind("gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)") <
                ncg_source.find("update_stage_completion_from_stats(ctx, out_stats)"),
        "native FEM GPU nonlinear-CG accepted steps must update runtime stage completion from finalized native stats");
    check(
        ncg_source.find("#include \"cpu/mfem/runtime/stage_completion.hpp\"") !=
                std::string::npos &&
            ncg_source.find("FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT") !=
                std::string::npos &&
            ncg_source.find("\"tangent_gradient_norm_sq\"") !=
                std::string::npos &&
            ncg_source.find("set_stage_completion(") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG must publish gradient-converged stop state through the runtime stage-completion owner");
    const auto ncg_degenerate_gradient =
        ncg_source.rfind("if (gradient_norm_sq <= kGradientFloor)");
    const auto ncg_degenerate_finalize =
        ncg_degenerate_gradient == std::string::npos
            ? std::string::npos
            : ncg_source.find(
                  "gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)",
                  ncg_degenerate_gradient);
    check(
        ncg_source.find("void mark_gpu_relax_ncg_device_source_of_truth(") !=
                std::string::npos &&
            ncg_degenerate_gradient != std::string::npos &&
            ncg_degenerate_finalize != std::string::npos &&
            ncg_source.find(
                "mark_gpu_relax_ncg_device_source_of_truth(ctx)",
                ncg_degenerate_gradient) < ncg_degenerate_finalize,
        "native FEM GPU nonlinear-CG must publish device source-of-truth before zero-gradient stats/stage completion");
    check(
        ncg_source.find("gpu_relax_restore_previous_state_after_failure(") !=
                std::string::npos &&
            ncg_source.find("gpu_relax_restore_previous_magnetization(") !=
                std::string::npos &&
            ncg_source.find("gpu_relax_restore_previous_direction(") !=
                std::string::npos &&
            ncg_source.find("previous device state restored") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG must rollback both magnetization and persistent direction state on failed line-search/finalization paths");
    check(
        kernels_header.find("fullmag_cuda_relax_ncg_prepare_direction_blocks(") !=
                std::string::npos &&
            kernels_header.find("fullmag_cuda_relax_ncg_gradient_direction_and_norm_blocks(") !=
                std::string::npos &&
            kernels_header.find("fullmag_cuda_relax_ncg_pr_plus_numerator_blocks(") !=
                std::string::npos &&
            kernels_header.find("fullmag_cuda_relax_ncg_update_direction_blocks(") !=
                std::string::npos &&
            kernels_header.find("fullmag_cuda_relax_ncg_reset_direction_if_not_descent(") !=
                std::string::npos &&
            kernels_source.find("ncg_prepare_direction_kernel") !=
                std::string::npos &&
            kernels_source.find("ncg_gradient_direction_and_norm_kernel") !=
                std::string::npos &&
            kernels_source.find("block_reduce_triple_sum(") !=
                std::string::npos &&
            kernels_source.find("block_gradient_norm_sq[blockIdx.x]") !=
                std::string::npos &&
            kernels_source.find("block_p_dot_g[blockIdx.x]") !=
                std::string::npos &&
            kernels_source.find("block_direction_norm_sq[blockIdx.x]") !=
                std::string::npos &&
            kernels_source.find("ncg_pr_plus_numerator_kernel") !=
                std::string::npos &&
            kernels_source.find("ncg_update_direction_kernel") !=
                std::string::npos &&
            kernels_source.find("ncg_reset_direction_if_not_descent_kernel") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG must expose device kernels for descent preparation, PR+ numerator reduction, and next-direction update");
    check(
        relaxation_state.find("GPU CUDA relaxation device-state module header") !=
                std::string::npos &&
            relaxation_state.find("struct FemGpuRelaxationDeviceState") !=
                std::string::npos &&
            relaxation_state.find("FemGpuComponentField nonlinear_cg_direction") !=
                std::string::npos &&
            relaxation_state.find("FemGpuComponentField nonlinear_cg_direction_backup") !=
                std::string::npos &&
            relaxation_state.find("bool nonlinear_cg_direction_valid = false") !=
                std::string::npos &&
            relaxation_state.find("host-side std::vector state") !=
                std::string::npos,
        "native FEM GPU nonlinear CG must reserve persistent device-state storage instead of relying on host vectors");
    check(
        relaxation_memory_header.find("gpu_relaxation_state_allocate(") !=
                std::string::npos &&
            relaxation_memory_header.find("gpu_relaxation_state_free(") !=
                std::string::npos &&
            relaxation_memory_source.find("gpu_device_allocate_component(") !=
                std::string::npos &&
            relaxation_memory_source.find(
                "relaxation.nonlinear_cg_direction") !=
                std::string::npos &&
            relaxation_memory_source.find(
                "relaxation.nonlinear_cg_direction_backup") !=
                std::string::npos &&
            relaxation_memory_source.find("gpu_device_free_component(") !=
                std::string::npos,
        "native FEM GPU relaxation memory must allocate and free nonlinear-CG direction and rollback storage on the device");
    check(
        relaxation_memory_source.find("relaxation.node_count = node_count") !=
                std::string::npos &&
            relaxation_memory_source.find(
                "relaxation.nonlinear_cg_direction_valid = false") !=
                std::string::npos &&
            relaxation_memory_source.find("gpu_relaxation_state_free(relaxation)") !=
                std::string::npos &&
            relaxation_memory_source.rfind(
                "relaxation.nonlinear_cg_direction_valid = false") >
                relaxation_memory_source.find("void gpu_relaxation_state_free"),
        "native FEM GPU relaxation memory must invalidate persistent NCG direction state on allocation failure and free");
    check(
        gpu_state_header.find("#include \"gpu/cuda/relaxation/relaxation_state.hpp\"") !=
                std::string::npos &&
            gpu_state_header.find("FemGpuRelaxationDeviceState relaxation{}") !=
                std::string::npos,
        "FemGpuState must own persistent native GPU relaxation state");
    check(
        gpu_state_source.find("#include \"gpu/cuda/relaxation/relaxation_memory.hpp\"") !=
                std::string::npos &&
            gpu_state_source.find("gpu_relaxation_state_allocate(") !=
                std::string::npos &&
            gpu_state_source.find("gpu_relaxation_state_free(state.relaxation)") !=
                std::string::npos &&
            gpu_state_source.find("state.relaxation.node_count = 0") !=
                std::string::npos &&
            gpu_state_source.find(
                "state.relaxation.nonlinear_cg_direction_valid = false") !=
                std::string::npos,
        "FemGpuState lifecycle must allocate, free, and invalidate persistent native GPU relaxation state");
}

void fem_relaxation_benchmark_recipes_prepare_required_binaries() {
    const std::string justfile = read_text_file(repo_root() / "justfile");
    const std::string benchmark_script =
        read_text_file(repo_root() / "scripts" / "analysis" / "fem_gpu_benchmark.py");
    const std::string fem_sys_build =
        read_text_file(repo_root() / "crates" / "fullmag-fem-sys" / "build.rs");
    const auto recipe_start =
        justfile.find("verify-fem-relaxation-cpu-gpu-consistency-smoke:");
    const auto recipe_end =
        recipe_start == std::string::npos
            ? std::string::npos
            : justfile.find("\nresource-first-gates ", recipe_start);
    const std::string recipe =
        recipe_start == std::string::npos
            ? std::string()
            : justfile.substr(
                  recipe_start,
                  recipe_end == std::string::npos
                      ? std::string::npos
                      : recipe_end - recipe_start);
    const auto managed_runtime = recipe.find("just ensure-managed-fem-runtime");
    const auto benchmark =
        recipe.find("python3 scripts/analysis/fem_gpu_benchmark.py");

    check(
        !recipe.empty(),
        "justfile must define verify-fem-relaxation-cpu-gpu-consistency-smoke");
    check(
        recipe.find("just build fullmag") == std::string::npos,
        "FEM relaxation CPU/GPU consistency smoke must not require a separate host-built CPU CLI");
    check(
        managed_runtime != std::string::npos && benchmark != std::string::npos &&
            managed_runtime < benchmark,
        "FEM relaxation CPU/GPU consistency smoke must prepare the managed FEM runtime before running the benchmark harness");
    check(
        benchmark_script.find("FULLMAG_BENCH_CPU_BIN") != std::string::npos &&
            benchmark_script.find("str(FULLMAG_GPU)") != std::string::npos &&
            benchmark_script.find(
                "FULLMAG_CPU = REPO_ROOT / \".fullmag\" / \"local\" / \"bin\" / \"fullmag\"") ==
                std::string::npos,
        "FEM CPU/GPU benchmark harness must default FEM CPU runs to the managed FEM runtime bundle, not a host-built local CLI");
    check(
        benchmark_script.find("REPO_ROOT / \"native\" / \"backends\" / \"fem\"") ==
                std::string::npos &&
            benchmark_script.find("REPO_ROOT / \"backends\" / \"fem\"") !=
                std::string::npos,
        "FEM CPU/GPU benchmark preflight must inspect the current backends/fem tree, not the retired native/backends/fem path");
    check(
        fem_sys_build.find("cargo:rerun-if-changed=../../backends/fem/gpu") !=
            std::string::npos,
        "fullmag-fem-sys build script must rerun native CMake when backends/fem/gpu changes");
}

} // namespace

int main() {
    native_relaxation_algorithms_live_under_mfem_relaxation();
    c_abi_exposes_native_relaxation_step();
    runner_does_not_claim_production_fem_minimizer_ownership();
    gpu_relaxation_pgbb_building_blocks_live_under_native_cuda();
    gpu_relaxation_ncg_direction_state_is_device_persistent();
    fem_relaxation_benchmark_recipes_prepare_required_binaries();
    return 0;
}

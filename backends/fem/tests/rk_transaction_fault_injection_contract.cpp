/*
 * Native RK transaction fault-injection and telemetry contract.
 *
 * The larger explicit-RK contract executes the production failpoints. This
 * target keeps the transaction-owned inventory and the profile-on/off
 * rollback assertions independent, so a future refactor cannot silently
 * remove the test from the native contract recipe.
 */

#include "context.hpp"
#include "cpu/mfem/integrators/rk_step_transaction.hpp"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

std::string read_text_file(const std::filesystem::path &path)
{
    std::ifstream input(path);
    check(input.good(), "transaction contract source file must be readable");
    std::ostringstream contents;
    contents << input.rdbuf();
    return contents.str();
}

std::filesystem::path fem_source_root()
{
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

void initialize_transaction_context(
    fullmag::fem::Context &ctx,
    bool profile_enabled)
{
    ctx.mesh.n_nodes = 2;
    ctx.state.m_xyz = {1.0, 2.0, 3.0, 4.0, 5.0, 6.0};
    ctx.exchange.h_xyz = {7.0, 8.0, 9.0};
    ctx.demag.h_xyz = {10.0, 11.0, 12.0};
    ctx.demag.h_visual_xyz = {13.0, 14.0, 15.0};
    ctx.demag.cached_xyz = {16.0, 17.0, 18.0};
    ctx.effective_field.h_xyz = {19.0, 20.0, 21.0};
    ctx.effective_field.h_visual_xyz = {22.0, 23.0, 24.0};
    ctx.anisotropy.h_uniaxial_xyz = {25.0, 26.0, 27.0};
    ctx.dmi.h_interfacial_xyz = {28.0, 29.0, 30.0};
    ctx.oersted.h_xyz = {31.0, 32.0, 33.0};
    ctx.thermal_brown.h_xyz = {34.0, 35.0, 36.0};
    ctx.stepper.workspace.k[0] = {37.0, 38.0, 39.0};
    ctx.stepper.workspace.fsal_valid = true;
    ctx.gpu_state.rk_phase_timings.override_configured = true;
    ctx.gpu_state.rk_phase_timings.override_enabled = profile_enabled;
    // An unallocated GPU lane makes this contract deterministic on a host
    // without CUDA while still exercising the common transaction owner.
    ctx.gpu_state.device.lifecycle.allocated = false;
}

void source_inventory_covers_every_production_failure_boundary()
{
    const auto root = fem_source_root();
    const std::string injection = read_text_file(
        root / "cpu" / "mfem" / "integrators" / "rk_step_failure_injection.hpp");
    const std::string step = read_text_file(
        root / "cpu" / "mfem" / "integrators" / "rk_explicit_step.cpp");
    const std::string backend = read_text_file(
        root / "cpu" / "mfem" / "runtime" / "backend_step.cpp");
    const std::string transaction = read_text_file(
        root / "cpu" / "mfem" / "integrators" / "rk_step_transaction.cpp");
    const std::string runtime_state = read_text_file(
        root / "cpu" / "mfem" / "integrators" / "rk_stepper_workspace.hpp");

    for (const char *field : {
             "AfterCandidateMagnetization",
             "DuringFinalFieldRefresh",
             "DuringFinalStatistics",
         }) {
        check(
            injection.find(field) != std::string::npos,
            "failure-injection enum must expose every production boundary");
    }
    check(
        step.find("RkStepFailurePoint::AfterCandidateMagnetization") !=
            std::string::npos,
        "candidate-magnetization failure boundary must be executable");
    check(
        step.find("RkStepFailurePoint::DuringFinalFieldRefresh") !=
            std::string::npos,
        "final-field failure boundary must be executable");
    check(
        backend.find("RkStepFailurePoint::DuringFinalStatistics") !=
            std::string::npos,
        "final-statistics failure boundary must be executable");
    for (const char *field : {
             "step_transaction_host_snapshot_payload_bytes",
             "step_transaction_host_restore_payload_bytes",
             "step_transaction_rollback_count",
             "step_transaction_commit_count",
             "step_transaction_host_capture_wall_time_ns",
             "step_transaction_host_restore_wall_time_ns",
         }) {
        check(
            runtime_state.find(field) != std::string::npos &&
                transaction.find(field) != std::string::npos,
            "transaction telemetry field must have a runtime owner and publication update");
    }
    check(
        transaction.find("saturating_add") != std::string::npos,
        "transaction byte accounting must use saturating addition");
}

void rollback_restores_transaction_owned_state_and_counts_payload()
{
    fullmag::fem::Context ctx;
    initialize_transaction_context(ctx, true);
    const auto m_before = ctx.state.m_xyz;
    const auto demag_before = ctx.demag.h_xyz;
    const auto effective_before = ctx.effective_field.h_xyz;
    const auto k0_before = ctx.stepper.workspace.k[0];
    std::string error;
    fullmag::fem::RkStepTransaction transaction(ctx);
    check(transaction.begin(error), error.c_str());

    ctx.state.m_xyz.assign(ctx.state.m_xyz.size(), -1.0);
    ctx.demag.h_xyz.assign(ctx.demag.h_xyz.size(), -2.0);
    ctx.effective_field.h_xyz.assign(ctx.effective_field.h_xyz.size(), -3.0);
    ctx.stepper.workspace.k[0].assign(ctx.stepper.workspace.k[0].size(), -4.0);
    check(transaction.rollback(error), error.c_str());

    check(ctx.state.m_xyz == m_before, "transaction rollback restores magnetization bitwise");
    check(ctx.demag.h_xyz == demag_before, "transaction rollback restores demag field bitwise");
    check(
        ctx.effective_field.h_xyz == effective_before,
        "transaction rollback restores effective field bitwise");
    check(ctx.stepper.workspace.k[0] == k0_before, "transaction rollback restores FSAL state bitwise");
    check(
        ctx.stepper.transaction_telemetry.step_transaction_begin_count == 1u &&
            ctx.stepper.transaction_telemetry.step_transaction_rollback_count == 1u &&
            ctx.stepper.transaction_telemetry.step_transaction_commit_count == 0u,
        "profiled rollback must publish one begin and one rollback");
    check(
        ctx.stepper.transaction_telemetry.step_transaction_host_snapshot_payload_bytes > 0u &&
            ctx.stepper.transaction_telemetry.step_transaction_host_restore_payload_bytes ==
                ctx.stepper.transaction_telemetry.step_transaction_host_snapshot_payload_bytes,
        "profiled rollback must report exact host capture and restore bytes");
}

void profiler_off_does_not_allocate_or_count_transaction_telemetry()
{
    fullmag::fem::Context ctx;
    initialize_transaction_context(ctx, false);
    std::string error;
    fullmag::fem::RkStepTransaction transaction(ctx);
    check(transaction.begin(error), error.c_str());
    check(transaction.rollback(error), error.c_str());
    const auto &telemetry = ctx.stepper.transaction_telemetry;
    check(telemetry.step_transaction_begin_count == 0u, "profiler-off must not count captures");
    check(telemetry.step_transaction_rollback_count == 0u, "profiler-off must not count rollbacks");
    check(telemetry.step_transaction_host_snapshot_payload_bytes == 0u,
          "profiler-off must not calculate host capture bytes");
    check(telemetry.step_transaction_host_restore_payload_bytes == 0u,
          "profiler-off must not calculate host restore bytes");
}

} // namespace

int main()
{
    source_inventory_covers_every_production_failure_boundary();
    rollback_restores_transaction_owned_state_and_counts_payload();
    profiler_off_does_not_allocate_or_count_transaction_telemetry();
    return 0;
}

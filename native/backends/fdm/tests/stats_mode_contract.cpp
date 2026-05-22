/*
 * stats_mode_contract.cpp - native FDM step telemetry contract.
 *
 * Step execution must be separable from expensive scalar diagnostics.  The
 * default ABI value remains full stats for compatibility, but callers can
 * request skipped step-end diagnostics and retrieve full stats later through
 * snapshot_stats.
 */

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {

void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

std::string read_text_file(const std::filesystem::path &path) {
    std::ifstream in(path);
    if (!in) {
        std::fprintf(stderr, "FAIL: unable to read %s\n", path.string().c_str());
        std::exit(1);
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

std::filesystem::path repo_root() {
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path().parent_path().parent_path();
    }
    return std::filesystem::current_path() /
        this_file.parent_path().parent_path().parent_path().parent_path();
}

void stats_mode_is_part_of_public_plan() {
    const std::filesystem::path root = repo_root();
    const std::string header = read_text_file(root / "include" / "fullmag_fdm.h");

    check(
        header.find("typedef enum {\n    FULLMAG_FDM_STATS_FULL = 0") != std::string::npos,
        "fullmag_fdm_stats_mode must default zero-initialized plans to full stats");
    check(
        header.find("FULLMAG_FDM_STATS_NONE") != std::string::npos,
        "fullmag_fdm_stats_mode must expose a no-step-stats mode");
    check(
        header.find("fullmag_fdm_stats_mode") != std::string::npos &&
            header.find("stats_mode;") != std::string::npos,
        "fullmag_fdm_plan_desc must include stats_mode");
    check(
        header.find("uint32_t                   stats_stride") != std::string::npos,
        "fullmag_fdm_plan_desc must include stats_stride");
}

void step_sources_gate_expensive_diagnostics() {
    const std::filesystem::path root = repo_root() / "backends" / "fdm";
    const std::string context = read_text_file(root / "include" / "context.hpp");

    check(
        context.find("fullmag_fdm_should_fill_step_stats") != std::string::npos,
        "context.hpp must expose a shared step-stats gating helper");
    check(
        context.find("fullmag_fdm_fill_step_stats_metadata") != std::string::npos,
        "context.hpp must expose a metadata-only step-stats helper");

    const char *sources[] = {
        "llg_fp64.cu",
        "llg_fp32.cu",
        "llg_rk4_fp64.cu",
        "llg_rk4_fp32.cu",
        "llg_rk23_fp64.cu",
        "llg_rk23_fp32.cu",
        "llg_dp45_fp64.cu",
        "llg_dp45_fp32.cu",
        "llg_abm3_fp64.cu",
        "llg_abm3_fp32.cu",
    };

    for (const char *source : sources) {
        const std::string text = read_text_file(root / "cuda" / "integrators" / source);
        check(
            text.find("fullmag_fdm_should_fill_step_stats") != std::string::npos,
            "each native LLG step source must check stats gating before expensive diagnostics");
        check(
            text.find("fullmag_fdm_fill_step_stats_metadata(ctx, stats,") != std::string::npos,
            "each native LLG step source must provide metadata-only stats when diagnostics are skipped");
    }
}

void step_sources_avoid_whole_device_stats_barriers() {
    const std::filesystem::path root = repo_root() / "backends" / "fdm";
    const char *sources[] = {
        "llg_fp64.cu",
        "llg_fp32.cu",
        "llg_rk4_fp64.cu",
        "llg_rk4_fp32.cu",
        "llg_rk23_fp64.cu",
        "llg_rk23_fp32.cu",
        "llg_dp45_fp64.cu",
        "llg_dp45_fp32.cu",
        "llg_abm3_fp64.cu",
        "llg_abm3_fp32.cu",
    };

    for (const char *source : sources) {
        const std::string text = read_text_file(root / "cuda" / "integrators" / source);
        check(
            text.find("cudaDeviceSynchronize()") == std::string::npos,
            "native LLG step sources must not use whole-device sync for step stats");
    }
}

} // namespace

int main() {
    stats_mode_is_part_of_public_plan();
    step_sources_gate_expensive_diagnostics();
    step_sources_avoid_whole_device_stats_barriers();
    std::printf("stats mode contract: PASS\n");
    return 0;
}

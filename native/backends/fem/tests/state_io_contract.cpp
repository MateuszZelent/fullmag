/*
 * state_io_contract.cpp - native FEM runtime state I/O contracts.
 */

#include "context.hpp"
#include "cpu/mfem/runtime/state_io.hpp"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

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

std::filesystem::path fem_source_root() {
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

void context_state_io_is_owned_by_runtime_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string state_io =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "state_io.cpp");
    const std::string state_io_header =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "state_io.hpp");

    check(
        context.find("bool context_sync_gpu_magnetization_to_host(") == std::string::npos,
        "GPU magnetization readback must not be defined in context.cpp");
    check(
        context.find("int context_copy_field_f64(") == std::string::npos,
        "observable field copy must not be defined in context.cpp");
    check(
        context.find("int context_upload_magnetization_f64(") == std::string::npos,
        "magnetization upload must not be defined in context.cpp");
    check(
        context_header.find("context_sync_gpu_magnetization_to_host") == std::string::npos,
        "GPU magnetization readback declaration must not live in context.hpp");
    check(
        context_header.find("context_copy_field_f64") == std::string::npos,
        "observable field copy declaration must not live in context.hpp");
    check(
        context_header.find("context_upload_magnetization_f64") == std::string::npos,
        "magnetization upload declaration must not live in context.hpp");
    check(
        state_io.find("bool context_sync_gpu_magnetization_to_host(") != std::string::npos,
        "GPU magnetization readback must be defined in state_io.cpp");
    check(
        state_io.find("int context_copy_field_f64(") != std::string::npos,
        "observable field copy must be defined in state_io.cpp");
    check(
        state_io.find("int context_upload_magnetization_f64(") != std::string::npos,
        "magnetization upload must be defined in state_io.cpp");
    check(
        state_io_header.find("Synchronize and expose native FEM context state I/O") !=
            std::string::npos,
        "state_io header must document runtime state I/O ownership");
}

void observable_copy_prefers_visual_demag_and_effective_fields() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 2;
    ctx.demag.h_xyz = {1.0, 2.0, 3.0, 4.0, 5.0, 6.0};
    ctx.demag.h_visual_xyz = {11.0, 12.0, 13.0, 14.0, 15.0, 16.0};
    ctx.effective_field.h_xyz = {21.0, 22.0, 23.0, 24.0, 25.0, 26.0};
    ctx.effective_field.h_visual_xyz = {31.0, 32.0, 33.0, 34.0, 35.0, 36.0};

    double out[6] = {};
    std::string error;
    check(
        fullmag::fem::context_copy_field_f64(
            ctx,
            FULLMAG_FEM_OBSERVABLE_H_DEMAG,
            out,
            6,
            error) == FULLMAG_FEM_OK,
        "visual demag field copy should succeed");
    check(out[0] == 11.0 && out[5] == 16.0, "demag copy must prefer visual field");
    check(
        ctx.transfer_audit.counters.d2h_bytes == sizeof(out) &&
            ctx.transfer_audit.counters.host_read_count == 1,
        "observable copy must record D2H transfer audit");

    check(
        fullmag::fem::context_copy_field_f64(
            ctx,
            FULLMAG_FEM_OBSERVABLE_H_EFF,
            out,
            6,
            error) == FULLMAG_FEM_OK,
        "visual effective field copy should succeed");
    check(out[0] == 31.0 && out[5] == 36.0, "effective field copy must prefer visual field");
}

void upload_magnetization_updates_host_state_and_invalidates_runtime_caches() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 2;
    ctx.has_external_field = true;
    ctx.enable_exchange = false;
    ctx.enable_demag = false;
    ctx.zeeman.h_ext_xyz = {1.0, 0.0, 0.0, 0.0, 1.0, 0.0};
    ctx.exchange.h_xyz.assign(6, 9.0);
    ctx.demag.h_xyz.assign(6, 8.0);
    ctx.effective_field.h_xyz.assign(6, 7.0);
    ctx.thermal_brown.h_xyz.assign(6, 6.0);
    ctx.stepper.fsal_valid = true;
    ctx.adaptive_dt.prev_error_norm = 0.5;
    ctx.demag.cache_valid = true;
    ctx.demag.last_refresh_time = 4.0;
    ctx.thermal_brown.sigma = 5.0;
    ctx.thermal_brown.last_refresh_time = 2.0;
    ctx.thermal_brown.last_refresh_dt = 3.0;

    const double m_xyz[] = {
        0.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
    };
    std::string error;
    check(
        fullmag::fem::context_upload_magnetization_f64(ctx, m_xyz, 6, error) ==
            FULLMAG_FEM_OK,
        "host-resident magnetization upload should succeed");
    check(ctx.state.m_xyz == std::vector<double>(m_xyz, m_xyz + 6), "magnetization copied");
    check(!ctx.stepper.fsal_valid, "FSAL cache invalidated");
    check(ctx.adaptive_dt.prev_error_norm == 1.0, "adaptive previous error reset");
    check(!ctx.demag.cache_valid, "demag cache invalidated");
    check(ctx.demag.last_refresh_time == -1.0, "demag refresh timestamp reset");
    check(ctx.exchange.h_xyz == std::vector<double>(6, 0.0), "disabled exchange field zeroed");
    check(ctx.demag.h_xyz == std::vector<double>(6, 0.0), "disabled demag field zeroed");
    check(ctx.effective_field.h_xyz == ctx.zeeman.h_ext_xyz, "fallback H_eff seeded from external field");
    check(ctx.thermal_brown.sigma == 0.0, "thermal sigma reset");
    check(ctx.thermal_brown.last_refresh_time == -1.0, "thermal refresh time reset");
    check(ctx.thermal_brown.last_refresh_dt == -1.0, "thermal refresh dt reset");
    for (double value : ctx.thermal_brown.h_xyz) {
        check(value == 0.0, "thermal field zeroed on upload");
    }
    check(
        ctx.transfer_audit.counters.h2d_bytes == sizeof(m_xyz) &&
            ctx.transfer_audit.counters.host_write_count == 1,
        "host-resident upload must record H2D transfer audit");
}

} // namespace

int main() {
    context_state_io_is_owned_by_runtime_module();
    observable_copy_prefers_visual_demag_and_effective_fields();
    upload_magnetization_updates_host_state_and_invalidates_runtime_caches();
    return 0;
}

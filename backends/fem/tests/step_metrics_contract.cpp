/*
 * step_metrics_contract.cpp - native FEM step metric aggregation contracts.
 */

#include "context.hpp"
#include "core/fem_material_runtime.hpp"
#include "cpu/mfem/runtime/step_metrics.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <new>
#include <sstream>
#include <string>
#include <vector>

namespace allocation_probe {
bool enabled = false;
std::size_t count = 0u;
}

void *operator new(std::size_t size) {
    if (allocation_probe::enabled) {
        ++allocation_probe::count;
    }
    if (void *memory = std::malloc(size == 0u ? 1u : size)) {
        return memory;
    }
    throw std::bad_alloc();
}

void *operator new[](std::size_t size) {
    return ::operator new(size);
}

void operator delete(void *memory) noexcept {
    std::free(memory);
}

void operator delete[](void *memory) noexcept {
    std::free(memory);
}

void operator delete(void *memory, std::size_t) noexcept {
    std::free(memory);
}

void operator delete[](void *memory, std::size_t) noexcept {
    std::free(memory);
}

namespace {

constexpr double kPiTest = 3.14159265358979323846;
constexpr double kMu0Test = 4.0e-7 * kPiTest;

void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

void check_near(double actual, double expected, double tol, const char *msg) {
    if (std::fabs(actual - expected) > tol) {
        std::fprintf(
            stderr,
            "FAIL: %s: expected %.17g, got %.17g\n",
            msg,
            expected,
            actual);
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

void step_metrics_are_owned_by_runtime_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string phase_timings_header =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "phase_timings.hpp");
    const std::string metrics =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "step_metrics.cpp");

    const char *symbols[] = {
        "std::array<double, 3> average_magnetization_components(",
        "double max_norm_aos(",
        "double max_cross_norm_aos(",
        "double max_cross_norm_aos_free(",
        "void fill_demag_solver_stats(",
        "void fill_common_step_metrics(",
    };
    for (const char *symbol : symbols) {
        check(
            bridge.find(symbol) == std::string::npos,
            "step metric helper must not be defined in mfem_bridge.cpp");
        check(
            metrics.find(symbol) != std::string::npos,
            "step metric helper must be defined in step_metrics.cpp");
    }
    check(
        context_header.find("struct PhaseTimings {") == std::string::npos,
        "PhaseTimings definition must not live in context.hpp");
    check(
        phase_timings_header.find("struct PhaseTimings {") != std::string::npos,
        "PhaseTimings definition must live in runtime/phase_timings.hpp");
    check(
        phase_timings_header.find("Native FEM per-phase wall-clock timings") !=
            std::string::npos,
        "PhaseTimings header must document phase telemetry ownership");
}

void fill_common_step_metrics_reports_energy_fields_torque_and_averages() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 3;
    ctx.material_fields.material.saturation_magnetisation = 800e3;
    ctx.material_fields.Ms_field = {800e3, 1.0e6, 500e3};
    ctx.integration_weights.mfem_lumped_mass = {1.0e-27, 2.0e-27, 3.0e-27};
    ctx.mesh.magnetic_node_mask = {1u, 1u, 0u};
#if FULLMAG_HAS_MFEM_STACK
    ctx.cpu_threads.requested_omp_threads = 7;
    ctx.cpu_threads.effective_omp_threads = 3;
    ctx.cpu_threads.cap_reason = fullmag::fem::FULLMAG_FEM_CPU_THREAD_CAP_SMALL_MESH;
#endif

    ctx.zeeman.has_external_field = true;
    ctx.zeeman.h_ext_xyz = {
        10.0, 0.0, 0.0,
        0.0, 20.0, 0.0,
        0.0, 0.0, 30.0,
    };
    fullmag::fem::RegionalFieldDriveRuntime drive;
    drive.waveform.kind = FULLMAG_FEM_TIME_CONSTANT;
    drive.basis_h_xyz = {
        0.0, 7.0, 0.0,
        0.0, 8.0, 0.0,
        0.0, 0.0, 9.0,
    };
    ctx.zeeman.regional_drives.push_back(drive);
    ctx.zeeman.h_drive_xyz.assign(9, 0.0);
    ctx.state.m_xyz = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 0.0,
    };
    ctx.effective_field.h_xyz = {
        0.0, 2.0, 0.0,
        0.0, 0.0, 3.0,
        0.0, 0.0, 0.0,
    };
    ctx.demag.h_xyz = {
        4.0, 0.0, 0.0,
        0.0, 5.0, 0.0,
        0.0, 0.0, 0.0,
    };
    ctx.anisotropy.energy_joules = 1.0;
    ctx.dmi.energy_joules = 2.0;
    ctx.magnetoelastic.energy_joules = 3.0;

    fullmag_fem_step_stats stats{};
    stats.exchange_energy_joules = 4.0;
    stats.demag_energy_joules = 5.0;
#if FULLMAG_HAS_MFEM_STACK
    fullmag::fem::PhaseTimings timings{};
    fullmag::fem::fill_common_step_metrics(ctx, stats, 6.0, &timings);
#else
    fullmag::fem::fill_common_step_metrics(ctx, stats, 6.0, nullptr);
#endif

    const double expected_external =
        -kMu0Test * (800e3 * 10.0 * 1.0e-27 + 1.0e6 * 20.0 * 2.0e-27);
    const double expected_drive =
        -kMu0Test * (1.0e6 * 8.0 * 2.0e-27);
    check_near(
        stats.external_energy_joules,
        expected_external,
        std::fabs(expected_external) * 1e-12,
        "external energy is filled");
    check_near(
        stats.drive_energy_joules,
        expected_drive,
        std::fabs(expected_drive) * 1e-12,
        "regional drive energy is filled without half factor");
    check_near(
        stats.total_energy_joules,
        4.0 + 5.0 + expected_external + expected_drive + 1.0 + 2.0 + 3.0,
        1e-30,
        "total energy aggregation");
    check_near(stats.max_effective_field_amplitude, 3.0, 1e-15, "max H_eff");
    check_near(stats.max_demag_field_amplitude, 5.0, 1e-15, "max H_demag");
    check_near(stats.max_rhs_amplitude, 6.0, 1e-15, "max RHS passthrough");
    check_near(stats.max_torque_Apm, 3.0, 1e-15, "max torque m cross H_eff");
    check_near(stats.mx, 2.0 / 7.0, 1e-15, "Ms-times-lumped-volume weighted mx");
    check_near(stats.my, 5.0 / 7.0, 1e-15, "Ms-times-lumped-volume weighted my");
    check_near(stats.mz, 0.0, 1e-15, "average mz");
#if FULLMAG_HAS_MFEM_STACK
    check(stats.requested_omp_threads == 7, "requested OMP threads");
    check(stats.effective_omp_threads == 3, "effective OMP threads");
    check(
        stats.cpu_thread_cap_reason == fullmag::fem::FULLMAG_FEM_CPU_THREAD_CAP_SMALL_MESH,
        "CPU thread cap reason is filled");
    check(timings.extra_energy_wall_time_ns > 0, "extra energy timing is accumulated");
#endif
}

void torque_metric_excludes_non_magnetic_and_frozen_nodes() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 3;
    ctx.mesh.magnetic_node_mask = {1u, 0u, 1u};
    ctx.state.m_xyz = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    ctx.effective_field.h_xyz = {
        0.0, 2.0, 0.0,
        0.0, 100.0, 0.0,
        100.0, 0.0, 0.0,
    };
    const uint8_t frozen_mask[] = {0u, 0u, 1u};
    const double frozen_reference[] = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    std::string error;
    check(
        ctx.frozen_spins.import_descriptor(
            frozen_mask,
            3u,
            frozen_reference,
            9u,
            3u,
            2u,
            "step-metrics-test",
            error),
        "frozen descriptor imports for torque free-set test");

    fullmag_fem_step_stats stats{};
    fullmag::fem::fill_common_step_metrics(ctx, stats, 0.0, nullptr);
    check_near(
        stats.max_torque_Apm,
        2.0,
        1e-15,
        "torque metric excludes airbox and frozen nodes");
}

void torque_metric_is_zero_for_all_frozen_nodes() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 2;
    ctx.mesh.magnetic_node_mask = {1u, 1u};
    ctx.state.m_xyz = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    ctx.effective_field.h_xyz = {
        0.0, 100.0, 0.0,
        100.0, 0.0, 0.0,
    };
    const uint8_t frozen_mask[] = {1u, 1u};
    const double frozen_reference[] = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    std::string error;
    check(
        ctx.frozen_spins.import_descriptor(
            frozen_mask,
            2u,
            frozen_reference,
            6u,
            2u,
            2u,
            "step-metrics-all-frozen-test",
            error),
        "all-frozen descriptor imports for torque free-set test");

    fullmag_fem_step_stats stats{};
    fullmag::fem::fill_common_step_metrics(ctx, stats, 0.0, nullptr);
    check_near(
        stats.max_torque_Apm,
        0.0,
        0.0,
        "torque metric is zero for an all-frozen magnetic set");
}

void torque_metric_fails_closed_on_mask_extent_mismatch() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 1;
    ctx.mesh.magnetic_node_mask = {1u, 1u};
    ctx.state.m_xyz = {1.0, 0.0, 0.0};
    ctx.effective_field.h_xyz = {0.0, 1.0, 0.0};

    fullmag_fem_step_stats stats{};
    fullmag::fem::fill_common_step_metrics(ctx, stats, 0.0, nullptr);
    check(
        !std::isfinite(stats.max_torque_Apm),
        "torque metric fails closed on a mask extent mismatch");
}

void average_magnetization_consumes_dg0_ms_without_nodal_projection() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 8;
    ctx.state.m_xyz.assign(24u, 0.0);
    for (std::size_t node = 0; node < 4u; ++node) {
        ctx.state.m_xyz[node * 3u] = 1.0;
    }
    for (std::size_t node = 4u; node < 8u; ++node) {
        ctx.state.m_xyz[node * 3u + 1u] = 1.0;
    }
    ctx.material_fields.Ms_element_field = {1.0, 3.0};
    ctx.material_fields.runtime.emplace(fullmag::fem::P1TetrahedralMaterialRealization(
        8u,
        {
            {{{0u, 1u, 2u, 3u}}, 1.0},
            {{{4u, 5u, 6u, 7u}}, 1.0},
        },
        {0u, 1u},
        {fullmag::fem::MaterialCoefficientLocation::element_dg0, {1.0, 3.0}},
        {fullmag::fem::MaterialCoefficientLocation::uniform, {1.0}}));

    const auto average = fullmag::fem::average_magnetization_components(ctx);
    check_near(average[0], 0.25, 1e-15, "DG0 Ms weighted mx");
    check_near(average[1], 0.75, 1e-15, "DG0 Ms weighted my");
    check_near(average[2], 0.0, 1e-15, "DG0 Ms weighted mz");
}

void dg0_average_magnetization_is_allocation_free() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 8;
    ctx.state.m_xyz.assign(24u, 0.0);
    for (std::size_t node = 0; node < 4u; ++node) {
        ctx.state.m_xyz[node * 3u] = 1.0;
    }
    for (std::size_t node = 4u; node < 8u; ++node) {
        ctx.state.m_xyz[node * 3u + 1u] = 1.0;
    }
    ctx.material_fields.Ms_element_field = {1.0, 3.0};
    ctx.material_fields.runtime.emplace(fullmag::fem::P1TetrahedralMaterialRealization(
        8u,
        {
            {{{0u, 1u, 2u, 3u}}, 1.0},
            {{{4u, 5u, 6u, 7u}}, 1.0},
        },
        {0u, 1u},
        {fullmag::fem::MaterialCoefficientLocation::element_dg0, {1.0, 3.0}},
        {fullmag::fem::MaterialCoefficientLocation::uniform, {1.0}}));

    allocation_probe::count = 0u;
    allocation_probe::enabled = true;
    const auto average = fullmag::fem::average_magnetization_components(ctx);
    allocation_probe::enabled = false;

    check(allocation_probe::count == 0u, "DG0 average magnetization must not heap-allocate");
    check_near(average[0], 0.25, 1e-15, "allocation-free DG0 mx");
    check_near(average[1], 0.75, 1e-15, "allocation-free DG0 my");
    check_near(average[2], 0.0, 1e-15, "allocation-free DG0 mz");
}

void mixed_average_does_not_fallback_to_geometry_over_arity_node_volumes() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 2;
    ctx.mesh.cell_types = {FULLMAG_FEM_CELL_PRISM6, FULLMAG_FEM_CELL_PYRAMID5};
    ctx.mesh.node_volumes = {1.0, 3.0};
    ctx.mesh.magnetic_node_mask = {1u, 1u};
    ctx.material_fields.material.saturation_magnetisation = 1.0;
    ctx.state.m_xyz = {1.0, 0.0, 0.0, 0.0, 1.0, 0.0};

    const auto missing = fullmag::fem::average_magnetization_components(ctx);
    check_near(missing[0], 0.0, 0.0, "mixed average rejects missing MFEM weights");
    check_near(missing[1], 0.0, 0.0, "mixed average rejects legacy node-volume fallback");
    check_near(missing[2], 0.0, 0.0, "mixed average rejects missing canonical measure");

    ctx.integration_weights.mfem_lumped_mass = {1.0};
    const auto wrong_extent = fullmag::fem::average_magnetization_components(ctx);
    check_near(wrong_extent[0], 0.0, 0.0, "mixed average rejects partial MFEM weights");
    check_near(wrong_extent[1], 0.0, 0.0, "mixed average rejects wrong weight extent");
}

} // namespace

int main() {
    step_metrics_are_owned_by_runtime_module();
    fill_common_step_metrics_reports_energy_fields_torque_and_averages();
    torque_metric_excludes_non_magnetic_and_frozen_nodes();
    torque_metric_is_zero_for_all_frozen_nodes();
    torque_metric_fails_closed_on_mask_extent_mismatch();
    average_magnetization_consumes_dg0_ms_without_nodal_projection();
    dg0_average_magnetization_is_allocation_free();
    mixed_average_does_not_fallback_to_geometry_over_arity_node_volumes();
    return 0;
}

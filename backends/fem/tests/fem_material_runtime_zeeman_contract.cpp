#include "context.hpp"
#include "core/fem_material_runtime.hpp"
#include "cpu/mfem/interactions/zeeman_energy.hpp"

#include <array>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <string>
#include <vector>

namespace {

constexpr double kMu0 = 4.0e-7 * 3.141592653589793238462643383279502884;

[[noreturn]] void fail(const char *message) {
    std::fprintf(stderr, "FAIL: %s\n", message);
    std::exit(1);
}

void check(bool condition, const char *message) {
    if (!condition) fail(message);
}

void check_near(double actual, double expected, const char *message) {
    const double scale = std::max(1.0, std::max(std::fabs(actual), std::fabs(expected)));
    if (std::fabs(actual - expected) > 256.0 * std::numeric_limits<double>::epsilon() * scale) {
        std::fprintf(stderr, "FAIL: %s expected %.17g got %.17g\n", message, expected, actual);
        std::exit(1);
    }
}

double independent_two_tetra_oracle(
    const std::vector<std::array<std::size_t, 4>> &elements,
    const std::vector<double> &volumes,
    const std::vector<double> &ms,
    const std::vector<std::size_t> &active,
    const std::vector<double> &left,
    const std::vector<double> &right)
{
    double sum = 0.0;
    for (const std::size_t element : active) {
        for (std::size_t a = 0; a < 4; ++a) {
            for (std::size_t b = 0; b < 4; ++b) {
                double dot = 0.0;
                for (std::size_t c = 0; c < 3; ++c) {
                    dot += left[elements[element][a] * 3u + c] *
                        right[elements[element][b] * 3u + c];
                }
                sum += ms[element] * volumes[element] *
                    (a == b ? 2.0 : 1.0) * dot / 20.0;
            }
        }
    }
    return -kMu0 * sum;
}

void sharp_ms_context(fullmag::fem::Context &ctx) {
    ctx.mesh.n_nodes = 6u;
    ctx.mesh.n_elements = 3u;
    ctx.mesh.nodes_xyz = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 2.0,
        0.0, 0.0, 3.0,
    };
    ctx.mesh.cell_nodes = {
        0u, 1u, 2u, 3u,
        0u, 1u, 2u, 4u,
        0u, 1u, 2u, 5u,
    };
    ctx.mesh.cell_types = {
        FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4};
    ctx.mesh.cell_offsets = {0u, 4u, 8u, 12u};
    ctx.mesh.magnetic_element_mask = {1u, 1u, 0u};
    ctx.material_fields.material.saturation_magnetisation = 0.8e6;
    ctx.material_fields.Ms_element_field = {0.7e6, 1.1e6, 3.0e6};
    ctx.material_fields.A_element_field = {0.0, 0.0, 0.0};
    ctx.zeeman.has_external_field = true;
    ctx.zeeman.h_ext_xyz = {
        11.0, -7.0, 3.0,
        -5.0, 13.0, 2.0,
        17.0, 19.0, -23.0,
        29.0, -31.0, 37.0,
        -41.0, 43.0, 47.0,
        53.0, -59.0, 61.0,
    };
}

void context_adapter_keeps_ordered_active_scope_and_drives_sharp_ms_zeeman() {
    fullmag::fem::Context ctx;
    sharp_ms_context(ctx);
    std::string error;
    check(fullmag::fem::initialize_material_runtime(ctx, error),
          "material runtime adapter must construct from validated mesh and masks");
    check(ctx.material_fields.runtime.has_value(),
          "material runtime adapter must be owned by material fields state");
    const auto &runtime = *ctx.material_fields.runtime;
    check(runtime.realization().active_element_ordinals() == std::vector<std::size_t>({0u, 1u}),
          "material runtime must preserve ordered magnetic element ordinals and exclude air");

    const std::vector<double> current = {
        0.2, -0.4, 0.7,
        -0.1, 0.6, 0.3,
        0.5, 0.1, -0.2,
        0.9, -0.3, 0.4,
        -0.7, 0.8, 0.2,
        0.6, -0.5, 0.9,
    };
    std::vector<double> trial = current;
    trial[0] += 0.3;
    trial[8] -= 0.2;
    trial[12] += 0.4;
    const std::vector<std::array<std::size_t, 4>> elements = {
        {{0u, 1u, 2u, 3u}}, {{0u, 1u, 2u, 4u}}, {{0u, 1u, 2u, 5u}},
    };
    const std::vector<double> volumes = {1.0 / 6.0, 1.0 / 3.0, 1.0 / 2.0};
    const std::vector<double> ms = {0.7e6, 1.1e6, 3.0e6};
    const std::vector<std::size_t> active = {0u, 1u};
    const double expected_current = independent_two_tetra_oracle(
        elements, volumes, ms, active, current, ctx.zeeman.h_ext_xyz);
    const double expected_trial = independent_two_tetra_oracle(
        elements, volumes, ms, active, trial, ctx.zeeman.h_ext_xyz);
    check_near(fullmag::fem::zeeman_energy_from_field(ctx, current), expected_current,
               "sharp Ms production Zeeman energy must use adapter exact active DG0 mass");
    const auto delta = fullmag::fem::zeeman_energy_difference_from_field(ctx, current, trial);
    check_near(delta.delta_joules, expected_trial - expected_current,
               "sharp Ms production Zeeman delta must use adapter exact active DG0 mass");
}

void sharp_ms_zeeman_difference_tracks_component_termwise_roundoff() {
    fullmag::fem::Context ctx;
    sharp_ms_context(ctx);
    for (std::size_t node = 0; node < ctx.mesh.n_nodes; ++node) {
        const std::size_t base = node * 3u;
        ctx.zeeman.h_ext_xyz[base + 0u] = 1.0;
        ctx.zeeman.h_ext_xyz[base + 1u] = -1.0;
        ctx.zeeman.h_ext_xyz[base + 2u] = 0.0;
    }
    std::string error;
    check(fullmag::fem::initialize_material_runtime(ctx, error),
          "material runtime adapter must construct for sharp-Ms cancellation fixture");

    std::vector<double> current(ctx.mesh.n_nodes * 3u, 0.0);
    std::vector<double> trial = current;
    trial[0u] = 1.0;
    trial[1u] = 1.0;
    const auto difference =
        fullmag::fem::zeeman_energy_difference_from_field(ctx, current, trial);

    check_near(difference.delta_joules, 0.0,
               "sharp-Ms Zeeman cancellation fixture must retain its algebraic delta");
    check(difference.absolute_term_sum_joules > std::fabs(difference.delta_joules),
          "sharp-Ms Zeeman difference must retain componentwise absolute terms after cancellation");
    check_near(
        difference.roundoff_bound_joules,
        fullmag::fem::relaxation::reduction_roundoff_bound(2u * 4u * 4u * 3u) *
            difference.absolute_term_sum_joules,
        "sharp-Ms Zeeman roundoff bound must derive from componentwise absolute terms");
}

} // namespace

int main() {
    context_adapter_keeps_ordered_active_scope_and_drives_sharp_ms_zeeman();
    sharp_ms_zeeman_difference_tracks_component_termwise_roundoff();
    std::puts("fem_material_runtime_zeeman_contract: PASS");
    return 0;
}

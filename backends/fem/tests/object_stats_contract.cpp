#include "fullmag_fem.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {

constexpr double kMu0 = 4.0e-7 * 3.14159265358979323846;

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void check_near(double actual, double expected, const char *message)
{
    const double tolerance = 1.0e-12 * std::max(1.0, std::fabs(expected));
    check(std::fabs(actual - expected) <= tolerance, message);
}

fullmag_fem_plan_desc two_tetra_plan()
{
    static const double nodes[] = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 2.0,
    };
    static const uint32_t cell_types[] = {FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4};
    static const uint32_t cell_offsets[] = {0, 4, 8};
    static const uint32_t cell_nodes[] = {0, 1, 2, 3, 0, 1, 2, 4};
    static const uint64_t cell_ordinals[] = {0, 1};
    static const uint32_t cell_markers[] = {1, 2};
    static const uint32_t facet_types[] = {
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
    };
    static const uint32_t facet_roles[] = {
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    };
    static const uint32_t facet_offsets[] = {0, 3, 6, 9, 12, 15, 18};
    static const uint32_t facet_nodes[] = {
        0, 1, 3, 0, 2, 3, 1, 2, 3,
        0, 1, 4, 0, 2, 4, 1, 2, 4,
    };
    static const uint64_t facet_ordinals[] = {0, 1, 2, 3, 4, 5};
    static const uint32_t facet_markers[] = {1, 1, 1, 1, 1, 1};
    static const double magnetization[] = {
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
    };

    fullmag_fem_plan_desc plan{};
    plan.mesh.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
    plan.mesh.struct_size = sizeof(fullmag_fem_mesh_desc);
    plan.mesh.nodes_xyz = nodes;
    plan.mesh.nodes_xyz_len = 15;
    plan.mesh.cell_types = cell_types;
    plan.mesh.cell_types_len = 2;
    plan.mesh.cell_offsets = cell_offsets;
    plan.mesh.cell_offsets_len = 3;
    plan.mesh.cell_nodes = cell_nodes;
    plan.mesh.cell_nodes_len = 8;
    plan.mesh.cell_global_ordinals = cell_ordinals;
    plan.mesh.cell_global_ordinals_len = 2;
    plan.mesh.cell_markers = cell_markers;
    plan.mesh.cell_markers_len = 2;
    plan.mesh.facet_types = facet_types;
    plan.mesh.facet_types_len = 6;
    plan.mesh.facet_roles = facet_roles;
    plan.mesh.facet_roles_len = 6;
    plan.mesh.facet_offsets = facet_offsets;
    plan.mesh.facet_offsets_len = 7;
    plan.mesh.facet_nodes = facet_nodes;
    plan.mesh.facet_nodes_len = 18;
    plan.mesh.facet_global_ordinals = facet_ordinals;
    plan.mesh.facet_global_ordinals_len = 6;
    plan.mesh.facet_markers = facet_markers;
    plan.mesh.facet_markers_len = 6;
    plan.material.saturation_magnetisation = 2.0;
    plan.material.exchange_stiffness = 1.0;
    plan.material.damping = 0.1;
    plan.material.gyromagnetic_ratio = 2.211e5;
    plan.fe_order = 1;
    plan.hmax = 1.0;
    plan.precision = FULLMAG_FEM_PRECISION_DOUBLE;
    plan.integrator = FULLMAG_FEM_INTEGRATOR_RK23_BS;
    plan.initial_magnetization_xyz = magnetization;
    plan.initial_magnetization_len = 15;
    plan.has_external_field = 1;
    plan.enable_exchange = 1;
    plan.external_field_am[0] = 3.0;
    plan.dt_seconds = 1.0e-13;
    const char *device = std::getenv("FULLMAG_OBJECT_STATS_DEVICE");
    plan.mfem_device_string = device == nullptr ? "cpu" : device;
    plan.gpu_device_index = std::strcmp(plan.mfem_device_string, "cuda") == 0 ? 0 : -1;
    return plan;
}

fullmag_fem_object_stats_v1 stats_for(fullmag_fem_backend *backend, uint32_t element)
{
    fullmag_fem_object_stats_v1 stats{};
    stats.abi_version = FULLMAG_FEM_OBJECT_STATS_V1_ABI_VERSION;
    stats.struct_size = sizeof(stats);
    check(
        fullmag_fem_backend_object_stats_for_elements_v1(backend, &element, 1, &stats) ==
            FULLMAG_FEM_OK,
        "owned-element object reduction failed");
    return stats;
}

} // namespace

int main()
{
    auto plan = two_tetra_plan();
    fullmag_fem_backend *backend = fullmag_fem_backend_create(&plan);
    check(backend != nullptr, fullmag_fem_backend_last_error(nullptr));
    if (std::strcmp(plan.mfem_device_string, "cuda") == 0) {
        fullmag_fem_step_stats step_stats{};
        check(
            fullmag_fem_backend_step(backend, plan.dt_seconds, &step_stats) == FULLMAG_FEM_OK,
            "CUDA object reduction requires one successful device-resident step");
        fullmag_fem_device_info device{};
        fullmag_fem_gpu_state_info state{};
        check(
            fullmag_fem_backend_get_device_info(backend, &device) == FULLMAG_FEM_OK &&
                device.is_gpu_enabled != 0,
            "CUDA object reduction requires an active GPU device");
        check(
            fullmag_fem_backend_get_gpu_state_info(backend, &state) == FULLMAG_FEM_OK &&
                state.allocated != 0 &&
                state.source_of_truth == FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH,
            "CUDA object reduction requires device-resident magnetization");
        std::puts("fem_object_stats_contract: CUDA device state confirmed");
    }

    const auto first = stats_for(backend, 0);
    const auto second = stats_for(backend, 1);
    check_near(first.mx, 1.0, "first object average mx");
    check_near(second.mx, 1.0, "second object average mx");
    check_near(first.moment_weight, 1.0 / 3.0, "first object moment weight");
    check_near(second.moment_weight, 2.0 / 3.0, "second object moment weight");
    check_near(first.external_energy_joules, -kMu0, "first object Zeeman energy");
    check_near(second.external_energy_joules, -2.0 * kMu0, "second object Zeeman energy");
    check_near(
        first.total_energy_joules + second.total_energy_joules,
        -3.0 * kMu0,
        "object energies reproduce the full magnetic domain");

    uint32_t duplicate[] = {0, 0};
    fullmag_fem_object_stats_v1 invalid{};
    invalid.abi_version = FULLMAG_FEM_OBJECT_STATS_V1_ABI_VERSION;
    invalid.struct_size = sizeof(invalid);
    check(
        fullmag_fem_backend_object_stats_for_elements_v1(backend, duplicate, 2, &invalid) !=
            FULLMAG_FEM_OK,
        "duplicate element ownership must fail");
    const uint32_t out_of_range = 2;
    check(
        fullmag_fem_backend_object_stats_for_elements_v1(
            backend, &out_of_range, 1, &invalid) != FULLMAG_FEM_OK,
        "out-of-range element ownership must fail");

    fullmag_fem_backend_destroy(backend);
    std::puts("fem_object_stats_contract: PASS");
    return 0;
}

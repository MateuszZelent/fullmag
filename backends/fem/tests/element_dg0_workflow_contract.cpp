/* Native ABI contract for the bounded element-DG0 Ms workflow. */

#include "fullmag_fem.h"

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {

constexpr double kEdge = 8.0e-9;
const std::array<double, 12> kNodes = {
    0.0, 0.0, 0.0,
    kEdge, 0.0, 0.0,
    0.0, kEdge, 0.0,
    0.0, 0.0, kEdge,
};
const std::array<std::uint32_t, 4> kElements = {0u, 1u, 2u, 3u};
const std::array<std::uint32_t, 1> kCellTypes = {FULLMAG_FEM_CELL_TET4};
const std::array<std::uint32_t, 2> kCellOffsets = {0u, 4u};
const std::array<std::uint64_t, 1> kCellOrdinals = {0u};
const std::array<std::uint32_t, 1> kElementMarkers = {1u};
const std::array<std::uint32_t, 12> kBoundaryFaces = {
    0u, 2u, 1u,
    0u, 1u, 3u,
    0u, 3u, 2u,
    1u, 2u, 3u,
};
const std::array<std::uint32_t, 4> kBoundaryMarkers = {1u, 1u, 1u, 1u};
const std::array<std::uint32_t, 4> kFacetTypes = {
    FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
    FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
};
const std::array<std::uint32_t, 4> kFacetRoles = {
    FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
};
const std::array<std::uint32_t, 5> kFacetOffsets = {0u, 3u, 6u, 9u, 12u};
const std::array<std::uint64_t, 4> kFacetOrdinals = {0u, 1u, 2u, 3u};
const std::array<double, 12> kInitialM = {
    1.0, 0.0, 0.0,
    0.9950371902099892, 0.09950371902099892, 0.0,
    0.9950371902099892, 0.0, 0.09950371902099892,
    1.0, 0.0, 0.0,
};
const std::array<double, 1> kElementMs = {8.0e5};

[[noreturn]] void fail(const char *message) {
    std::fprintf(stderr, "FAIL: %s\n", message);
    std::exit(1);
}

void check(bool condition, const char *message) {
    if (!condition) {
        fail(message);
    }
}

const char *last_error(fullmag_fem_backend *backend) {
    const char *message = fullmag_fem_backend_last_error(backend);
    return message == nullptr ? "" : message;
}

fullmag_fem_plan_desc make_dg0_plan() {
    fullmag_fem_plan_desc plan{};
    plan.mesh.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
    plan.mesh.struct_size = sizeof(fullmag_fem_mesh_desc);
    plan.mesh.nodes_xyz = kNodes.data();
    plan.mesh.nodes_xyz_len = kNodes.size();
    plan.mesh.cell_types = kCellTypes.data();
    plan.mesh.cell_types_len = kCellTypes.size();
    plan.mesh.cell_offsets = kCellOffsets.data();
    plan.mesh.cell_offsets_len = kCellOffsets.size();
    plan.mesh.cell_nodes = kElements.data();
    plan.mesh.cell_nodes_len = kElements.size();
    plan.mesh.cell_global_ordinals = kCellOrdinals.data();
    plan.mesh.cell_global_ordinals_len = kCellOrdinals.size();
    plan.mesh.cell_markers = kElementMarkers.data();
    plan.mesh.cell_markers_len = kElementMarkers.size();
    plan.mesh.facet_types = kFacetTypes.data();
    plan.mesh.facet_types_len = kFacetTypes.size();
    plan.mesh.facet_roles = kFacetRoles.data();
    plan.mesh.facet_roles_len = kFacetRoles.size();
    plan.mesh.facet_offsets = kFacetOffsets.data();
    plan.mesh.facet_offsets_len = kFacetOffsets.size();
    plan.mesh.facet_nodes = kBoundaryFaces.data();
    plan.mesh.facet_nodes_len = kBoundaryFaces.size();
    plan.mesh.facet_global_ordinals = kFacetOrdinals.data();
    plan.mesh.facet_global_ordinals_len = kFacetOrdinals.size();
    plan.mesh.facet_markers = kBoundaryMarkers.data();
    plan.mesh.facet_markers_len = kBoundaryMarkers.size();
    plan.material.saturation_magnetisation = 8.0e5;
    plan.material.exchange_stiffness = 1.3e-11;
    plan.material.damping = 0.1;
    plan.material.gyromagnetic_ratio = 2.211e5;
    plan.fe_order = 1u;
    plan.hmax = kEdge;
    plan.precision = FULLMAG_FEM_PRECISION_DOUBLE;
    plan.integrator = FULLMAG_FEM_INTEGRATOR_RK23_BS;
    plan.enable_exchange = 1;
    plan.initial_magnetization_xyz = kInitialM.data();
    plan.initial_magnetization_len = kInitialM.size();
    plan.dt_seconds = 1.0e-18;
    plan.ms_element_field = kElementMs.data();
    plan.ms_element_field_len = kElementMs.size();
    plan.use_consistent_mass = 1;
    plan.gpu_device_index = -1;
    plan.mfem_device_string = "cpu";
    plan.eager_initial_effective_field = 1;
    return plan;
}

void ordinary_cpu_rk_remains_executable() {
    auto plan = make_dg0_plan();
    fullmag_fem_backend *backend = fullmag_fem_backend_create(&plan);
    check(backend != nullptr, "ordinary CPU DG0 backend creation must remain executable");
    fullmag_fem_step_stats stats{};
    const int status = fullmag_fem_backend_step(backend, plan.dt_seconds, &stats);
    if (status != FULLMAG_FEM_OK) {
        std::fprintf(stderr, "ordinary CPU DG0 RK error: %s\n", last_error(backend));
        fail("ordinary CPU DG0 RK step must remain executable");
    }
    fullmag_fem_backend_destroy(backend);
}

void reusable_time_handle_rejects_every_direct_relaxation_algorithm() {
    auto plan = make_dg0_plan();
    fullmag_fem_backend *backend = fullmag_fem_backend_create(&plan);
    check(backend != nullptr, "reusable CPU DG0 backend creation");
    const fullmag_fem_relax_algorithm algorithms[] = {
        FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB,
        FULLMAG_FEM_RELAX_NONLINEAR_CG,
        FULLMAG_FEM_RELAX_TANGENT_PLANE_IMPLICIT,
    };
    for (const auto algorithm : algorithms) {
        fullmag_fem_step_stats stats{};
        const int status = fullmag_fem_backend_relax_step(backend, algorithm, &stats);
        check(status == FULLMAG_FEM_ERR_UNAVAILABLE, "DG0 direct relaxation must fail unavailable");
        check(
            std::strstr(last_error(backend), "Ms_element_field") != nullptr &&
                std::strstr(last_error(backend), "relaxation") != nullptr,
            "DG0 direct relaxation error must name material and workflow");
    }
    fullmag_fem_backend_destroy(backend);
}

void llg_overdamped_plan_rejects_at_backend_creation() {
    auto plan = make_dg0_plan();
    plan.has_precession_enabled = 1;
    plan.precession_enabled = 0;
    plan.relax_stop.has_torque_tolerance_apm = 1;
    plan.relax_stop.torque_tolerance_apm = 1.0e-4;
    plan.relax_stop.has_max_steps = 1;
    plan.relax_stop.max_steps = 8u;
    fullmag_fem_backend *backend = fullmag_fem_backend_create(&plan);
    check(backend == nullptr, "DG0 LLG-overdamped plan must fail at native backend creation");
    check(
        std::strstr(last_error(nullptr), "Ms_element_field") != nullptr &&
            std::strstr(last_error(nullptr), "relaxation") != nullptr,
        "DG0 LLG-overdamped creation error must name material and workflow");
}

} // namespace

int main() {
    ordinary_cpu_rk_remains_executable();
    reusable_time_handle_rejects_every_direct_relaxation_algorithm();
    llg_overdamped_plan_rejects_at_backend_creation();
    return 0;
}

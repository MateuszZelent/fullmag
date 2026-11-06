/* Native ABI contract for the bounded element-DG0 Ms workflow. */

#include "fullmag_fem.h"

#include <array>
#include <cmath>
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

void prescribed_sot_plan_rejects_at_backend_creation() {
    auto plan = make_dg0_plan();
    plan.has_prescribed_sot = 1;
    plan.sot_formula_version = FULLMAG_FEM_SOT_FORMULA_PRESCRIBED_V1;
    plan.sot_current_density_am2 = 1.0e11;
    plan.sot_xi_dl = 0.12;
    plan.sot_xi_fl = -0.02;
    plan.sot_thickness = 1.5e-9;
    plan.sot_envelope_value = 1.0;
    plan.sot_sigma[1] = 1.0;
    fullmag_fem_backend *backend = fullmag_fem_backend_create(&plan);
    if (backend != nullptr) {
        fullmag_fem_backend_destroy(backend);
        fail("DG0 Ms with prescribed SOT must fail at native backend creation");
    }
    check(
        std::strstr(last_error(nullptr), "Ms_element_field") != nullptr &&
            std::strstr(last_error(nullptr), "prescribed SOT") != nullptr,
        "DG0 prescribed-SOT creation error must name material and owner");
}

// Two disjoint congruent tetrahedra: A (nodes 0-3) with Ms=400 kA/m and
// m=+x, B (nodes 4-7) with Ms=800 kA/m and m=-x.  The DG0 moment-weighted
// object average is sum(Ms_e V_e <m>_e) / sum(Ms_e V_e).
constexpr double kShift = 3.0 * kEdge;
const std::array<double, 24> kPairNodes = {
    0.0, 0.0, 0.0,
    kEdge, 0.0, 0.0,
    0.0, kEdge, 0.0,
    0.0, 0.0, kEdge,
    kShift, 0.0, 0.0,
    kShift + kEdge, 0.0, 0.0,
    kShift, kEdge, 0.0,
    kShift, 0.0, kEdge,
};
const std::array<std::uint32_t, 8> kPairElements = {0u, 1u, 2u, 3u, 4u, 5u, 6u, 7u};
const std::array<std::uint32_t, 2> kPairCellTypes = {
    FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4,
};
const std::array<std::uint32_t, 3> kPairCellOffsets = {0u, 4u, 8u};
const std::array<std::uint64_t, 2> kPairCellOrdinals = {0u, 1u};
const std::array<std::uint32_t, 2> kPairElementMarkers = {1u, 1u};
const std::array<std::uint32_t, 24> kPairBoundaryFaces = {
    0u, 2u, 1u,
    0u, 1u, 3u,
    0u, 3u, 2u,
    1u, 2u, 3u,
    4u, 6u, 5u,
    4u, 5u, 7u,
    4u, 7u, 6u,
    5u, 6u, 7u,
};
const std::array<std::uint32_t, 8> kPairBoundaryMarkers = {1u, 1u, 1u, 1u, 1u, 1u, 1u, 1u};
const std::array<std::uint32_t, 8> kPairFacetTypes = {
    FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
    FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
    FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
    FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
};
const std::array<std::uint32_t, 8> kPairFacetRoles = {
    FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
};
const std::array<std::uint32_t, 9> kPairFacetOffsets = {0u, 3u, 6u, 9u, 12u, 15u, 18u, 21u, 24u};
const std::array<std::uint64_t, 8> kPairFacetOrdinals = {0u, 1u, 2u, 3u, 4u, 5u, 6u, 7u};
const std::array<double, 24> kPairInitialM = {
    1.0, 0.0, 0.0,
    1.0, 0.0, 0.0,
    1.0, 0.0, 0.0,
    1.0, 0.0, 0.0,
    -1.0, 0.0, 0.0,
    -1.0, 0.0, 0.0,
    -1.0, 0.0, 0.0,
    -1.0, 0.0, 0.0,
};
const std::array<double, 2> kPairElementMs = {4.0e5, 8.0e5};

fullmag_fem_plan_desc make_dg0_pair_plan() {
    fullmag_fem_plan_desc plan = make_dg0_plan();
    plan.mesh.nodes_xyz = kPairNodes.data();
    plan.mesh.nodes_xyz_len = kPairNodes.size();
    plan.mesh.cell_types = kPairCellTypes.data();
    plan.mesh.cell_types_len = kPairCellTypes.size();
    plan.mesh.cell_offsets = kPairCellOffsets.data();
    plan.mesh.cell_offsets_len = kPairCellOffsets.size();
    plan.mesh.cell_nodes = kPairElements.data();
    plan.mesh.cell_nodes_len = kPairElements.size();
    plan.mesh.cell_global_ordinals = kPairCellOrdinals.data();
    plan.mesh.cell_global_ordinals_len = kPairCellOrdinals.size();
    plan.mesh.cell_markers = kPairElementMarkers.data();
    plan.mesh.cell_markers_len = kPairElementMarkers.size();
    plan.mesh.facet_types = kPairFacetTypes.data();
    plan.mesh.facet_types_len = kPairFacetTypes.size();
    plan.mesh.facet_roles = kPairFacetRoles.data();
    plan.mesh.facet_roles_len = kPairFacetRoles.size();
    plan.mesh.facet_offsets = kPairFacetOffsets.data();
    plan.mesh.facet_offsets_len = kPairFacetOffsets.size();
    plan.mesh.facet_nodes = kPairBoundaryFaces.data();
    plan.mesh.facet_nodes_len = kPairBoundaryFaces.size();
    plan.mesh.facet_global_ordinals = kPairFacetOrdinals.data();
    plan.mesh.facet_global_ordinals_len = kPairFacetOrdinals.size();
    plan.mesh.facet_markers = kPairBoundaryMarkers.data();
    plan.mesh.facet_markers_len = kPairBoundaryMarkers.size();
    plan.initial_magnetization_xyz = kPairInitialM.data();
    plan.initial_magnetization_len = kPairInitialM.size();
    plan.ms_element_field = kPairElementMs.data();
    plan.ms_element_field_len = kPairElementMs.size();
    return plan;
}

const std::array<double, 24> kSharedNodeTetNodes = {
    0.0, 0.0, 0.0,
    kEdge, 0.0, 0.0,
    0.0, kEdge, 0.0,
    0.0, 0.0, kEdge,
    kEdge, kEdge, kEdge,
    -kEdge, 0.0, 0.0,
    0.0, -kEdge, 0.0,
    0.0, 0.0, -kEdge,
};
const std::array<std::uint32_t, 20> kSharedNodeTetElements = {
    0u, 1u, 2u, 3u,
    1u, 2u, 3u, 4u,
    0u, 3u, 2u, 5u,
    0u, 1u, 3u, 6u,
    0u, 2u, 1u, 7u,
};
const std::array<std::uint32_t, 5> kSharedNodeTetCellTypes = {
    FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4,
    FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4,
};
const std::array<std::uint32_t, 6> kSharedNodeTetCellOffsets = {
    0u, 4u, 8u, 12u, 16u, 20u,
};
const std::array<std::uint64_t, 5> kSharedNodeTetCellOrdinals = {0u, 1u, 2u, 3u, 4u};
const std::array<std::uint32_t, 5> kSharedNodeTetElementMarkers = {1u, 1u, 1u, 1u, 1u};
const std::array<std::uint32_t, 5> kSharedNodeTetInactiveMarkers = {1u, 0u, 0u, 0u, 0u};
const std::array<std::uint32_t, 36> kSharedNodeTetBoundaryFaces = {
    1u, 2u, 4u, 1u, 3u, 4u, 2u, 3u, 4u,
    0u, 3u, 5u, 0u, 2u, 5u, 3u, 2u, 5u,
    0u, 1u, 6u, 0u, 3u, 6u, 1u, 3u, 6u,
    0u, 2u, 7u, 0u, 1u, 7u, 2u, 1u, 7u,
};
const std::array<std::uint32_t, 12> kSharedNodeTetBoundaryMarkers = {
    1u, 1u, 1u, 1u, 1u, 1u, 1u, 1u, 1u, 1u, 1u, 1u,
};
const std::array<std::uint32_t, 12> kSharedNodeTetFacetTypes = {
    FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
    FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
    FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
    FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
};
const std::array<std::uint32_t, 12> kSharedNodeTetFacetRoles = {
    FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
};
const std::array<std::uint32_t, 13> kSharedNodeTetFacetOffsets = {
    0u, 3u, 6u, 9u, 12u, 15u, 18u, 21u, 24u, 27u, 30u, 33u, 36u,
};
const std::array<std::uint64_t, 12> kSharedNodeTetFacetOrdinals = {
    0u, 1u, 2u, 3u, 4u, 5u, 6u, 7u, 8u, 9u, 10u, 11u,
};
const std::array<double, 24> kSharedNodeTetInitialM = {
    1.0, 0.0, 0.0,
    1.0, 0.0, 0.0,
    1.0, 0.0, 0.0,
    1.0, 0.0, 0.0,
    -1.0, 0.0, 0.0,
    -1.0, 0.0, 0.0,
    -1.0, 0.0, 0.0,
    -1.0, 0.0, 0.0,
};
const std::array<double, 5> kSharedNodeTetElementMs = {
    8.0e5, 4.0e5, 4.0e5, 4.0e5, 4.0e5,
};

fullmag_fem_plan_desc make_dg0_shared_node_plan() {
    fullmag_fem_plan_desc plan = make_dg0_plan();
    plan.mesh.nodes_xyz = kSharedNodeTetNodes.data();
    plan.mesh.nodes_xyz_len = kSharedNodeTetNodes.size();
    plan.mesh.cell_types = kSharedNodeTetCellTypes.data();
    plan.mesh.cell_types_len = kSharedNodeTetCellTypes.size();
    plan.mesh.cell_offsets = kSharedNodeTetCellOffsets.data();
    plan.mesh.cell_offsets_len = kSharedNodeTetCellOffsets.size();
    plan.mesh.cell_nodes = kSharedNodeTetElements.data();
    plan.mesh.cell_nodes_len = kSharedNodeTetElements.size();
    plan.mesh.cell_global_ordinals = kSharedNodeTetCellOrdinals.data();
    plan.mesh.cell_global_ordinals_len = kSharedNodeTetCellOrdinals.size();
    plan.mesh.cell_markers = kSharedNodeTetElementMarkers.data();
    plan.mesh.cell_markers_len = kSharedNodeTetElementMarkers.size();
    plan.mesh.facet_types = kSharedNodeTetFacetTypes.data();
    plan.mesh.facet_types_len = kSharedNodeTetFacetTypes.size();
    plan.mesh.facet_roles = kSharedNodeTetFacetRoles.data();
    plan.mesh.facet_roles_len = kSharedNodeTetFacetRoles.size();
    plan.mesh.facet_offsets = kSharedNodeTetFacetOffsets.data();
    plan.mesh.facet_offsets_len = kSharedNodeTetFacetOffsets.size();
    plan.mesh.facet_nodes = kSharedNodeTetBoundaryFaces.data();
    plan.mesh.facet_nodes_len = kSharedNodeTetBoundaryFaces.size();
    plan.mesh.facet_global_ordinals = kSharedNodeTetFacetOrdinals.data();
    plan.mesh.facet_global_ordinals_len = kSharedNodeTetFacetOrdinals.size();
    plan.mesh.facet_markers = kSharedNodeTetBoundaryMarkers.data();
    plan.mesh.facet_markers_len = kSharedNodeTetBoundaryMarkers.size();
    plan.initial_magnetization_xyz = kSharedNodeTetInitialM.data();
    plan.initial_magnetization_len = kSharedNodeTetInitialM.size();
    plan.ms_element_field = kSharedNodeTetElementMs.data();
    plan.ms_element_field_len = kSharedNodeTetElementMs.size();
    return plan;
}

void check_average_m(
    fullmag_fem_backend *backend,
    const std::uint32_t *nodes,
    std::uint64_t node_count,
    double expected_mx,
    const char *message) {
    std::array<double, 3> average = {0.0, 0.0, 0.0};
    const int status = fullmag_fem_backend_average_m_for_nodes_f64(
        backend, nodes, node_count, average.data(), average.size());
    if (status != FULLMAG_FEM_OK) {
        std::fprintf(stderr, "per-object average error: %s\n", last_error(backend));
        fail(message);
    }
    std::fprintf(
        stderr,
        "per-object average (%llu nodes): mx=%.17g my=%.17g mz=%.17g expected mx=%.17g\n",
        static_cast<unsigned long long>(node_count),
        average[0],
        average[1],
        average[2],
        expected_mx);
    check(
        std::abs(average[0] - expected_mx) <= 1.0e-12 &&
            std::abs(average[1]) <= 1.0e-12 && std::abs(average[2]) <= 1.0e-12,
        message);
}

void per_object_average_m_uses_element_moment_weights() {
    auto plan = make_dg0_pair_plan();
    fullmag_fem_backend *backend = fullmag_fem_backend_create(&plan);
    if (backend == nullptr) {
        std::fprintf(stderr, "DG0 pair backend creation error: %s\n", last_error(nullptr));
        fail("DG0 pair backend creation must succeed for the per-object average oracle");
    }
    const std::array<std::uint32_t, 8> both = {0u, 1u, 2u, 3u, 4u, 5u, 6u, 7u};
    const std::array<std::uint32_t, 4> first = {0u, 1u, 2u, 3u};
    const std::array<std::uint32_t, 4> second = {4u, 5u, 6u, 7u};
    // (400e3 * V * (+1) + 800e3 * V * (-1)) / (1200e3 * V) = -1/3.  A nodal
    // or scalar Ms weight would give 0 here, because both tetrahedra have the
    // same lumped volume.
    check_average_m(
        backend, both.data(), both.size(), -1.0 / 3.0,
        "object containing both DG0 elements must use the Ms_e V_e moment weights");
    check_average_m(
        backend, first.data(), first.size(), 1.0,
        "object containing only the 400 kA/m element must average to +x");
    check_average_m(
        backend, second.data(), second.size(), -1.0,
        "object containing only the 800 kA/m element must average to -x");
    fullmag_fem_backend_destroy(backend);
}

void element_set_average_excludes_a_foreign_tet_inside_the_object_node_set() {
    auto plan = make_dg0_shared_node_plan();
    fullmag_fem_backend *backend = fullmag_fem_backend_create(&plan);
    if (backend == nullptr) {
        std::fprintf(stderr, "shared-node DG0 backend creation error: %s\n", last_error(nullptr));
        fail("shared-node DG0 backend creation must succeed for the element-set oracle");
    }

    // The central foreign tetra uses nodes 0-3. Each of the four selected
    // exterior tetrahedra shares one central face, so their ordinary object
    // node set also contains all four central-tetra vertices. The legacy
    // node-set predicate therefore includes the foreign tetra.
    const std::array<std::uint32_t, 8> object_nodes = {0u, 1u, 2u, 3u, 4u, 5u, 6u, 7u};
    check_average_m(
        backend,
        object_nodes.data(),
        object_nodes.size(),
        9.0 / 14.0,
        "node-set reduction oracle must include the central foreign tetra");

    const std::array<std::uint32_t, 4> selected_elements = {1u, 2u, 3u, 4u};
    const auto check_element_average = [&](
        const std::uint32_t *elements,
        std::uint64_t element_count,
        double expected_mx,
        const char *message) {
        std::array<double, 3> average = {0.0, 0.0, 0.0};
        const int status = fullmag_fem_backend_average_m_for_elements_f64(
            backend, elements, element_count, average.data(), average.size());
        if (status != FULLMAG_FEM_OK) {
            std::fprintf(stderr, "element-set average error: %s\n", last_error(backend));
            fail(message);
        }
        check(
            std::abs(average[0] - expected_mx) <= 1.0e-12 &&
                std::abs(average[1]) <= 1.0e-12 &&
                std::abs(average[2]) <= 1.0e-12,
            message);
    };
    // Element 1 has twice the volume of the other tetrahedra. The shared face
    // vertices are +x and the outer apexes are -x, so each selected P1 element
    // averages to +0.5. Including the central element gives
    // (2 * 1 + 5 * 0.5) / (2 + 5) = 9/14 with Ms V weights.
    check_element_average(
        selected_elements.data(), selected_elements.size(), 0.5,
        "exact element-set reduction must exclude the central foreign tetra");
    const std::array<std::uint32_t, 6> duplicated_selection = {0u, 0u, 1u, 2u, 3u, 4u};
    check_element_average(
        duplicated_selection.data(), duplicated_selection.size(), 9.0 / 14.0,
        "duplicate element indices must have set semantics");

    std::array<double, 3> average = {1.0, 1.0, 1.0};
    int status = fullmag_fem_backend_average_m_for_elements_f64(
        backend, nullptr, 0u, average.data(), average.size());
    check(status == FULLMAG_FEM_ERR_INVALID,
        "an empty element set must be rejected");
    status = fullmag_fem_backend_average_m_for_elements_f64(
        nullptr,
        selected_elements.data(),
        selected_elements.size(),
        average.data(),
        average.size());
    check(status == FULLMAG_FEM_ERR_INVALID, "a null backend handle must be rejected");
    status = fullmag_fem_backend_average_m_for_elements_f64(
        backend, nullptr, 1u, average.data(), average.size());
    check(status == FULLMAG_FEM_ERR_INVALID &&
            std::strstr(last_error(backend), "null element_indices") != nullptr,
        "a null element array with positive count must be rejected");
    const std::array<std::uint32_t, 1> out_of_range = {5u};
    status = fullmag_fem_backend_average_m_for_elements_f64(
        backend, out_of_range.data(), out_of_range.size(), average.data(), average.size());
    check(status == FULLMAG_FEM_ERR_INVALID &&
            std::strstr(last_error(backend), "element index out of range") != nullptr,
        "an out-of-range element ordinal must be rejected");
    status = fullmag_fem_backend_average_m_for_elements_f64(
        backend, selected_elements.data(), selected_elements.size(), nullptr, 3u);
    check(status == FULLMAG_FEM_ERR_INVALID, "a null output vector must be rejected");
    status = fullmag_fem_backend_average_m_for_elements_f64(
        backend, selected_elements.data(), selected_elements.size(), average.data(), 2u);
    check(status == FULLMAG_FEM_ERR_INVALID, "a short output vector must be rejected");
    fullmag_fem_backend_destroy(backend);

    auto inactive_plan = make_dg0_shared_node_plan();
    inactive_plan.mesh.cell_markers = kSharedNodeTetInactiveMarkers.data();
    backend = fullmag_fem_backend_create(&inactive_plan);
    if (backend == nullptr) {
        std::fprintf(stderr, "inactive DG0 backend creation error: %s\n", last_error(nullptr));
        fail("inactive-element DG0 backend creation must succeed");
    }
    status = fullmag_fem_backend_average_m_for_elements_f64(
        backend, selected_elements.data(), selected_elements.size(), average.data(), average.size());
    check(
        status == FULLMAG_FEM_OK && average[0] == 0.0 &&
            average[1] == 0.0 && average[2] == 0.0,
        "a set containing only inactive elements must reduce to zero");
    fullmag_fem_backend_destroy(backend);

    auto uniform_plan = make_dg0_plan();
    uniform_plan.ms_element_field = nullptr;
    uniform_plan.ms_element_field_len = 0u;
    backend = fullmag_fem_backend_create(&uniform_plan);
    check(backend != nullptr, "uniform-Ms backend creation for element-average rejection");
    const std::array<std::uint32_t, 1> one_element = {0u};
    status = fullmag_fem_backend_average_m_for_elements_f64(
        backend, one_element.data(), one_element.size(), average.data(), average.size());
    check(status == FULLMAG_FEM_ERR_UNAVAILABLE &&
            std::strstr(last_error(backend), "element-DG0 Ms") != nullptr,
        "element-set average must remain unavailable without element-DG0 Ms");
    fullmag_fem_backend_destroy(backend);
}

} // namespace

int main(int argc, char **argv) {
    // Initial-state observables also run in the dependency-free ABI build.
    // Keep the full time-integration workflow as the default MFEM contract.
    if (argc == 2 && std::strcmp(argv[1], "--object-averages-only") == 0) {
        per_object_average_m_uses_element_moment_weights();
        element_set_average_excludes_a_foreign_tet_inside_the_object_node_set();
        return 0;
    }
    check(argc == 1, "unknown DG0 workflow contract argument");
    ordinary_cpu_rk_remains_executable();
    reusable_time_handle_rejects_every_direct_relaxation_algorithm();
    llg_overdamped_plan_rejects_at_backend_creation();
    prescribed_sot_plan_rejects_at_backend_creation();
    per_object_average_m_uses_element_moment_weights();
    element_set_average_excludes_a_foreign_tet_inside_the_object_node_set();
    return 0;
}

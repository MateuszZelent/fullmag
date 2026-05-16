/*
 * contract_validation.cpp — native FEM ABI contract smoke tests.
 *
 * Covers the early validation gates that must fire before the MFEM runtime
 * starts: availability lane separation, P1-only FEM order, and adaptive-RK
 * parameter sanity.
 */

#include "fullmag_fem.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

static void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

static fullmag_fem_plan_desc make_plan(const std::vector<double> &m0) {
    static const double nodes[] = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    static const uint32_t elements[] = {0, 1, 2, 3};
    static const uint32_t element_markers[] = {1};
    static const uint32_t boundary_faces[] = {0, 1, 2};
    static const uint32_t boundary_markers[] = {1};

    fullmag_fem_plan_desc plan = {};
    plan.mesh.nodes_xyz = nodes;
    plan.mesh.n_nodes = 4;
    plan.mesh.elements = elements;
    plan.mesh.n_elements = 1;
    plan.mesh.element_markers = element_markers;
    plan.mesh.boundary_faces = boundary_faces;
    plan.mesh.n_boundary_faces = 1;
    plan.mesh.boundary_markers = boundary_markers;
    plan.material.saturation_magnetisation = 800e3;
    plan.material.exchange_stiffness = 13e-12;
    plan.material.damping = 0.1;
    plan.material.gyromagnetic_ratio = 2.211e5;
    plan.fe_order = 1;
    plan.hmax = 1.0;
    plan.precision = FULLMAG_FEM_PRECISION_DOUBLE;
    plan.integrator = FULLMAG_FEM_INTEGRATOR_RK23_BS;
    plan.enable_exchange = 1;
    plan.initial_magnetization_xyz = m0.data();
    plan.initial_magnetization_len = static_cast<uint64_t>(m0.size());
    plan.dt_seconds = 1e-13;
    plan.demag_realization = FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
    plan.gpu_device_index = -1;
    return plan;
}

static void expect_create_error(fullmag_fem_plan_desc &plan, const char *needle) {
    fullmag_fem_backend *handle = fullmag_fem_backend_create(&plan);
    check(handle == nullptr, "fullmag_fem_backend_create should reject invalid plan");
    const char *error = fullmag_fem_backend_last_error(nullptr);
    check(error != nullptr && std::strstr(error, needle) != nullptr, needle);
}

int main() {
    fullmag_fem_availability_info availability = {};
    check(
        fullmag_fem_get_availability_info(&availability) == FULLMAG_FEM_OK,
        "fullmag_fem_get_availability_info failed");
    check(
        availability.available_any == availability.available,
        "available_any must mirror legacy available");
    check(
        availability.available_cpu == availability.native_fem_cpu_available,
        "available_cpu must mirror native_fem_cpu_available");
    check(
        availability.available_gpu == availability.native_fem_gpu_available,
        "available_gpu must mirror native_fem_gpu_available");
    if (availability.available_cpu != 0) {
        check(std::strlen(availability.reason_cpu) > 0, "available CPU lane must report reason_cpu");
    }
    if (availability.available_gpu == 0) {
        check(std::strlen(availability.reason_gpu) > 0, "unavailable GPU lane must report reason_gpu");
    }

    std::vector<double> m0 = {
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
    };

    fullmag_fem_plan_desc plan = make_plan(m0);
    plan.fe_order = 2;
    expect_create_error(plan, "fe_order = 1");

    fullmag_fem_adaptive_config adaptive = {};
    adaptive.atol = 1e-6;
    adaptive.rtol = 1e-3;
    adaptive.dt_initial = 1e-13;
    adaptive.dt_min = 1e-16;
    adaptive.dt_max = 1e-10;
    adaptive.safety = 1.0;
    adaptive.growth_limit = 2.0;
    adaptive.shrink_limit = 0.2;
    adaptive.max_reject = 50;

    plan = make_plan(m0);
    plan.adaptive_config = &adaptive;
    expect_create_error(plan, "0 < safety < 1");

    adaptive.safety = 0.9;
    adaptive.max_reject = 0;
    plan = make_plan(m0);
    plan.adaptive_config = &adaptive;
    expect_create_error(plan, "max_reject");

    return 0;
}

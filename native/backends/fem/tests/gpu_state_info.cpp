/*
 * gpu_state_info.cpp — Phase-1 FEM GPU state smoke test.
 *
 * Verifies that a native FEM backend handle exposes GPU-state lifecycle
 * metadata through C ABI even when this build has no CUDA runtime.
 */

#include "fullmag_fem.h"

#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <vector>

static void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

int main() {
    const double nodes[] = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    const uint32_t elements[] = {0, 1, 2, 3};
    const uint32_t element_markers[] = {1};
    const uint32_t boundary_faces[] = {0, 1, 2};
    const uint32_t boundary_markers[] = {1};
    std::vector<double> m0 = {
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
    };

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
    plan.integrator = FULLMAG_FEM_INTEGRATOR_HEUN;
    plan.enable_exchange = 1;
    plan.enable_demag = 0;
    plan.initial_magnetization_xyz = m0.data();
    plan.initial_magnetization_len = static_cast<uint64_t>(m0.size());
    plan.dt_seconds = 1e-13;
    plan.demag_realization = FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
    plan.gpu_device_index = -1;

    fullmag_fem_backend *handle = fullmag_fem_backend_create(&plan);
    check(handle != nullptr, "fullmag_fem_backend_create returned null");

    fullmag_fem_gpu_state_info info = {};
    const int rc = fullmag_fem_backend_get_gpu_state_info(handle, &info);
    check(rc == FULLMAG_FEM_OK, "fullmag_fem_backend_get_gpu_state_info failed");
    check(info.node_count == 4, "gpu_state node_count mismatch");
    check(info.dof_len == 12, "gpu_state dof_len mismatch");
    check(info.stage_count == 2, "gpu_state stage_count mismatch");
    check(
        info.source_of_truth == FULLMAG_FEM_RESIDENCY_HOST_SOURCE_OF_TRUTH,
        "gpu_state source_of_truth should stay host_source_of_truth before Phase 2");

    fullmag_fem_availability_info availability = {};
    check(
        fullmag_fem_get_availability_info(&availability) == FULLMAG_FEM_OK,
        "fullmag_fem_get_availability_info failed");
    if (availability.built_with_cuda_runtime == 0) {
        check(info.allocated == 0, "no-CUDA build must not report allocated GPU state");
        check(info.device_bytes == 0, "no-CUDA build must report zero device bytes");
        check(
            info.reduction_workspace_bytes == 0,
            "no-CUDA build must report zero reduction workspace bytes");
    }

    fullmag_fem_gpu_rk_plan_info rk_plan = {};
    check(
    fullmag_fem_backend_get_gpu_rk_plan_info(handle, &rk_plan) == FULLMAG_FEM_OK,
        "fullmag_fem_backend_get_gpu_rk_plan_info failed");
    check(rk_plan.stage_count == 2, "gpu_rk_plan stage_count mismatch");
    check(
        rk_plan.stage_exchange_device_resident == 0,
        "gpu_rk_plan must not report stage exchange as device-resident before Phase 2");
    check(
        std::strcmp(rk_plan.exchange_operator_mode, "unsupported") == 0,
        "gpu_rk_plan must expose unsupported exchange operator mode before Phase 3");
    if (availability.built_with_cuda_runtime == 0) {
        check(
            rk_plan.exchange_only_enabled == 0,
            "no-CUDA build must not enable exchange-only GPU RK");
        check(
            std::strlen(rk_plan.reason) > 0,
            "no-CUDA GPU RK plan must expose a block reason through C ABI");
        check(
            std::strstr(rk_plan.reason, "FemGpuState") != nullptr ||
                std::strstr(rk_plan.reason, "CUDA runtime") != nullptr,
            "no-CUDA GPU RK plan must expose the allocation or CUDA runtime blocker");
    }

    fullmag_fem_backend_destroy(handle);

    plan.integrator = FULLMAG_FEM_INTEGRATOR_RK23_BS;
    handle = fullmag_fem_backend_create(&plan);
    check(handle != nullptr, "RK23 fullmag_fem_backend_create returned null");

    info = {};
    check(
        fullmag_fem_backend_get_gpu_state_info(handle, &info) == FULLMAG_FEM_OK,
        "RK23 fullmag_fem_backend_get_gpu_state_info failed");
    check(info.stage_count == 4, "RK23 gpu_state stage_count mismatch");

    rk_plan = {};
    check(
        fullmag_fem_backend_get_gpu_rk_plan_info(handle, &rk_plan) == FULLMAG_FEM_OK,
        "RK23 fullmag_fem_backend_get_gpu_rk_plan_info failed");
    check(rk_plan.stage_count == 4, "RK23 gpu_rk_plan stage_count mismatch");
    check(
        std::strstr(rk_plan.reason, "Heun only") == nullptr,
        "RK23 gpu_rk_plan must not expose stale Heun-only block reason");

    fullmag_fem_backend_destroy(handle);

    plan.integrator = FULLMAG_FEM_INTEGRATOR_RK45_DP54;
    handle = fullmag_fem_backend_create(&plan);
    check(handle != nullptr, "RK45 fullmag_fem_backend_create returned null");

    info = {};
    check(
        fullmag_fem_backend_get_gpu_state_info(handle, &info) == FULLMAG_FEM_OK,
        "RK45 fullmag_fem_backend_get_gpu_state_info failed");
    check(info.stage_count == 7, "RK45 gpu_state stage_count mismatch");

    rk_plan = {};
    check(
        fullmag_fem_backend_get_gpu_rk_plan_info(handle, &rk_plan) == FULLMAG_FEM_OK,
        "RK45 fullmag_fem_backend_get_gpu_rk_plan_info failed");
    check(rk_plan.stage_count == 7, "RK45 gpu_rk_plan stage_count mismatch");
    check(
        std::strstr(rk_plan.reason, "Heun only") == nullptr,
        "RK45 gpu_rk_plan must not expose stale Heun-only block reason");

    fullmag_fem_backend_destroy(handle);

    plan.integrator = FULLMAG_FEM_INTEGRATOR_RK4;
    handle = fullmag_fem_backend_create(&plan);
    check(handle != nullptr, "RK4 fullmag_fem_backend_create returned null");

    info = {};
    check(
        fullmag_fem_backend_get_gpu_state_info(handle, &info) == FULLMAG_FEM_OK,
        "RK4 fullmag_fem_backend_get_gpu_state_info failed");
    check(info.stage_count == 4, "RK4 gpu_state stage_count mismatch");

    rk_plan = {};
    check(
        fullmag_fem_backend_get_gpu_rk_plan_info(handle, &rk_plan) == FULLMAG_FEM_OK,
        "RK4 fullmag_fem_backend_get_gpu_rk_plan_info failed");
    check(rk_plan.stage_count == 4, "RK4 gpu_rk_plan stage_count mismatch");
    check(
        std::strstr(rk_plan.reason, "Heun only") == nullptr,
        "RK4 gpu_rk_plan must not expose stale Heun-only block reason");

    fullmag_fem_backend_destroy(handle);
    std::printf("FEM gpu_state_info smoke PASS\n");
    return 0;
}

/*
 * Executed CUDA/MFEM contract for Track C (P0 #3):
 *  1. Heun & RK4 FSAL k[0] reuse (3->2 and 5->4 RHS/demag solves) + parity.
 *  2. Separation of fsal_k0_reuse vs endpoint_rhs_shortcut (including
 *     RK23/RK45 + frozen_spins never setting endpoint_valid=true).
 *  3. Complete FSAL invalidation matrix (pulse/host-expression drives,
 *     continuous SINUSOIDAL, time/field/stage_start/state_generation drift,
 *     frozen spins, PBC, thermal noise, callbacks, invalidate_fsal).
 *  4. Transaction rollback at RkStepFailurePoint::DuringFinalFieldRefresh
 *     preserving FSAL metadata and unswapped predictor history buffers.
 *  5. 2-step linear temporal potential predictor phi^(0) kernel math,
 *     equal-stage guard (stage_time_s > last_solved_stage_time_s), dt_ratio
 *     <= 2.0 guard, non-RK purpose auto-invalidation, zero-overhead no-op
 *     under cuDSS, and Krylov CG/AMG iteration reduction on 10 RK steps.
 */

#include "backend_handle.hpp"
#include "context.hpp"
#include "cpu/mfem/integrators/rk_step_failure_injection.hpp"
#include "fullmag_fem.h"
#include "gpu/cuda/demag_poisson/demag_predictor.hpp"
#include "gpu/cuda/demag_poisson/poisson.hpp"
#include "gpu/cuda/demag_poisson/stage_compute.hpp"
#include "gpu/cuda/integrators/rk/rk_fsal_policy.hpp"
#include "gpu/cuda/runtime/performance_counters.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string>
#include <tuple>
#include <vector>

namespace {

using namespace fullmag::fem;

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void check_msg(bool condition, const std::string &message)
{
    check(condition, message.c_str());
}

#if FULLMAG_HAS_CUDA_RUNTIME
void check_cuda(cudaError_t status, const char *message)
{
    if (status != cudaSuccess) {
        std::fprintf(stderr, "FAIL: %s: %s\n", message, cudaGetErrorString(status));
        std::exit(1);
    }
}
#endif

struct OwnedTetMesh {
    std::vector<double> nodes_xyz;
    std::vector<uint32_t> cell_types;
    std::vector<uint32_t> cell_offsets;
    std::vector<uint32_t> cell_nodes;
    std::vector<uint64_t> cell_ordinals;
    std::vector<uint32_t> cell_markers;
    std::vector<uint32_t> facet_types;
    std::vector<uint32_t> facet_roles;
    std::vector<uint32_t> facet_offsets;
    std::vector<uint32_t> facet_nodes;
    std::vector<uint64_t> facet_ordinals;
    std::vector<uint32_t> facet_markers;
    std::vector<uint32_t> periodic_node_pairs;
    std::vector<uint32_t> periodic_boundary_pair_markers;

    uint64_t node_count() const
    {
        return static_cast<uint64_t>(nodes_xyz.size() / 3u);
    }

    fullmag_fem_mesh_desc to_desc() const
    {
        fullmag_fem_mesh_desc desc{};
        desc.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
        desc.struct_size = sizeof(fullmag_fem_mesh_desc);
        desc.nodes_xyz = nodes_xyz.data();
        desc.nodes_xyz_len = static_cast<uint64_t>(nodes_xyz.size());
        desc.cell_types = cell_types.data();
        desc.cell_types_len = static_cast<uint64_t>(cell_types.size());
        desc.cell_offsets = cell_offsets.data();
        desc.cell_offsets_len = static_cast<uint64_t>(cell_offsets.size());
        desc.cell_nodes = cell_nodes.data();
        desc.cell_nodes_len = static_cast<uint64_t>(cell_nodes.size());
        desc.cell_global_ordinals = cell_ordinals.data();
        desc.cell_global_ordinals_len = static_cast<uint64_t>(cell_ordinals.size());
        desc.cell_markers = cell_markers.data();
        desc.cell_markers_len = static_cast<uint64_t>(cell_markers.size());
        desc.facet_types = facet_types.data();
        desc.facet_types_len = static_cast<uint64_t>(facet_types.size());
        desc.facet_roles = facet_roles.data();
        desc.facet_roles_len = static_cast<uint64_t>(facet_roles.size());
        desc.facet_offsets = facet_offsets.data();
        desc.facet_offsets_len = static_cast<uint64_t>(facet_offsets.size());
        desc.facet_nodes = facet_nodes.data();
        desc.facet_nodes_len = static_cast<uint64_t>(facet_nodes.size());
        desc.facet_global_ordinals = facet_ordinals.data();
        desc.facet_global_ordinals_len = static_cast<uint64_t>(facet_ordinals.size());
        desc.facet_markers = facet_markers.data();
        desc.facet_markers_len = static_cast<uint64_t>(facet_markers.size());
        desc.periodic_node_pairs =
            periodic_node_pairs.empty() ? nullptr : periodic_node_pairs.data();
        desc.periodic_node_pairs_len =
            static_cast<uint64_t>(periodic_node_pairs.size());
        desc.periodic_boundary_pair_markers =
            periodic_boundary_pair_markers.empty()
                ? nullptr
                : periodic_boundary_pair_markers.data();
        desc.periodic_boundary_pair_markers_len =
            static_cast<uint64_t>(periodic_boundary_pair_markers.size());
        return desc;
    }
};

OwnedTetMesh make_kuhn_cube_mesh(
    uint32_t nx,
    uint32_t ny,
    uint32_t nz,
    double lx,
    double ly,
    double lz,
    uint32_t exterior_marker = 99u)
{
    OwnedTetMesh mesh;
    const auto vid = [nx, ny](uint32_t ix, uint32_t iy, uint32_t iz) -> uint32_t {
        return (iz * (ny + 1u) + iy) * (nx + 1u) + ix;
    };
    const double dx = lx / static_cast<double>(nx);
    const double dy = ly / static_cast<double>(ny);
    const double dz = lz / static_cast<double>(nz);
    for (uint32_t iz = 0; iz <= nz; ++iz) {
        for (uint32_t iy = 0; iy <= ny; ++iy) {
            for (uint32_t ix = 0; ix <= nx; ++ix) {
                mesh.nodes_xyz.push_back(static_cast<double>(ix) * dx);
                mesh.nodes_xyz.push_back(static_cast<double>(iy) * dy);
                mesh.nodes_xyz.push_back(static_cast<double>(iz) * dz);
            }
        }
    }

    mesh.cell_offsets.push_back(0u);
    mesh.facet_offsets.push_back(0u);
    auto push_tet = [&mesh](uint32_t a, uint32_t b, uint32_t c, uint32_t d) {
        const uint64_t ordinal = static_cast<uint64_t>(mesh.cell_types.size());
        mesh.cell_types.push_back(FULLMAG_FEM_CELL_TET4);
        mesh.cell_nodes.push_back(a);
        mesh.cell_nodes.push_back(b);
        mesh.cell_nodes.push_back(c);
        mesh.cell_nodes.push_back(d);
        mesh.cell_offsets.push_back(static_cast<uint32_t>(mesh.cell_nodes.size()));
        mesh.cell_ordinals.push_back(ordinal);
        mesh.cell_markers.push_back(1u);
    };
    auto push_facet = [&mesh](uint32_t a, uint32_t b, uint32_t c, uint32_t marker) {
        const uint64_t ordinal = static_cast<uint64_t>(mesh.facet_types.size());
        mesh.facet_types.push_back(FULLMAG_FEM_FACET_TRI3);
        mesh.facet_roles.push_back(FULLMAG_FEM_FACET_ROLE_EXTERIOR);
        mesh.facet_nodes.push_back(a);
        mesh.facet_nodes.push_back(b);
        mesh.facet_nodes.push_back(c);
        mesh.facet_offsets.push_back(static_cast<uint32_t>(mesh.facet_nodes.size()));
        mesh.facet_ordinals.push_back(ordinal);
        mesh.facet_markers.push_back(marker);
    };

    for (uint32_t iz = 0; iz < nz; ++iz) {
        for (uint32_t iy = 0; iy < ny; ++iy) {
            for (uint32_t ix = 0; ix < nx; ++ix) {
                const uint32_t p000 = vid(ix, iy, iz);
                const uint32_t p100 = vid(ix + 1u, iy, iz);
                const uint32_t p010 = vid(ix, iy + 1u, iz);
                const uint32_t p110 = vid(ix + 1u, iy + 1u, iz);
                const uint32_t p001 = vid(ix, iy, iz + 1u);
                const uint32_t p101 = vid(ix + 1u, iy, iz + 1u);
                const uint32_t p011 = vid(ix, iy + 1u, iz + 1u);
                const uint32_t p111 = vid(ix + 1u, iy + 1u, iz + 1u);
                push_tet(p000, p100, p110, p111);
                push_tet(p000, p110, p010, p111);
                push_tet(p000, p010, p011, p111);
                push_tet(p000, p011, p001, p111);
                push_tet(p000, p001, p101, p111);
                push_tet(p000, p101, p100, p111);

                if (iz == 0u) {
                    push_facet(p000, p110, p100, exterior_marker);
                    push_facet(p000, p010, p110, exterior_marker);
                }
                if (iz + 1u == nz) {
                    push_facet(p001, p101, p111, exterior_marker);
                    push_facet(p001, p111, p011, exterior_marker);
                }
                if (iy == 0u) {
                    push_facet(p000, p100, p101, exterior_marker);
                    push_facet(p000, p101, p001, exterior_marker);
                }
                if (iy + 1u == ny) {
                    push_facet(p010, p111, p110, exterior_marker);
                    push_facet(p010, p011, p111, exterior_marker);
                }
                if (ix == 0u) {
                    push_facet(p000, p001, p011, exterior_marker);
                    push_facet(p000, p011, p010, exterior_marker);
                }
                if (ix + 1u == nx) {
                    push_facet(p100, p110, p111, exterior_marker);
                    push_facet(p100, p111, p101, exterior_marker);
                }
            }
        }
    }
    return mesh;
}

OwnedTetMesh make_x_periodic_kuhn_cube_mesh(
    uint32_t nx,
    uint32_t ny,
    uint32_t nz,
    double lx,
    double ly,
    double lz,
    uint32_t exterior_marker = 99u)
{
    OwnedTetMesh mesh = make_kuhn_cube_mesh(nx, ny, nz, lx, ly, lz, exterior_marker);
    const auto vid = [nx, ny](uint32_t ix, uint32_t iy, uint32_t iz) -> uint32_t {
        return (iz * (ny + 1u) + iy) * (nx + 1u) + ix;
    };
    for (uint32_t iz = 0u; iz <= nz; ++iz) {
        for (uint32_t iy = 0u; iy <= ny; ++iy) {
            mesh.periodic_node_pairs.push_back(vid(0u, iy, iz));
            mesh.periodic_node_pairs.push_back(vid(nx, iy, iz));
        }
    }
    return mesh;
}

std::vector<double> make_x_periodic_magnetization(const OwnedTetMesh &mesh, double ly)
{
    const uint64_t n = mesh.node_count();
    std::vector<double> m(static_cast<size_t>(3u * n), 0.0);
    for (uint64_t i = 0; i < n; ++i) {
        const double y = mesh.nodes_xyz[static_cast<size_t>(3u * i + 1u)] / ly;
        const double z = mesh.nodes_xyz[static_cast<size_t>(3u * i + 2u)] / ly;
        const double theta = 0.45 + 0.30 * y + 0.15 * z;
        const double phi = 0.25 + 0.50 * z;
        m[static_cast<size_t>(3u * i + 0u)] = std::cos(theta);
        m[static_cast<size_t>(3u * i + 1u)] = std::sin(theta) * std::cos(phi);
        m[static_cast<size_t>(3u * i + 2u)] = std::sin(theta) * std::sin(phi);
    }
    return m;
}

std::vector<double> make_smooth_magnetization(const OwnedTetMesh &mesh, double lx)
{
    const uint64_t n = mesh.node_count();
    std::vector<double> m(static_cast<size_t>(3u * n), 0.0);
    for (uint64_t i = 0; i < n; ++i) {
        const double x = mesh.nodes_xyz[static_cast<size_t>(3u * i + 0u)] / lx;
        const double y = mesh.nodes_xyz[static_cast<size_t>(3u * i + 1u)] / lx;
        const double z = mesh.nodes_xyz[static_cast<size_t>(3u * i + 2u)] / lx;
        const double theta = 0.45 + 0.35 * x + 0.15 * z;
        const double phi = 0.25 + 0.55 * y + 0.30 * z;
        m[static_cast<size_t>(3u * i + 0u)] = std::cos(theta);
        m[static_cast<size_t>(3u * i + 1u)] = std::sin(theta) * std::cos(phi);
        m[static_cast<size_t>(3u * i + 2u)] = std::sin(theta) * std::sin(phi);
    }
    return m;
}

fullmag_fem_plan_desc make_base_gpu_plan(
    const OwnedTetMesh &mesh,
    const std::vector<double> &initial_m,
    fullmag_fem_integrator integrator,
    double dt_seconds,
    bool enable_demag,
    uint32_t boundary_marker = 99u)
{
    fullmag_fem_plan_desc plan{};
    plan.mesh = mesh.to_desc();
    plan.material.saturation_magnetisation = 8.0e5;
    plan.material.exchange_stiffness = 1.3e-11;
    plan.material.damping = 0.05;
    plan.material.gyromagnetic_ratio = 2.211e5;
    plan.fe_order = 1u;
    plan.hmax = 10.0e-9;
    plan.precision = FULLMAG_FEM_PRECISION_DOUBLE;
    plan.integrator = integrator;
    plan.enable_exchange = 1;
    plan.enable_demag = enable_demag ? 1 : 0;
    plan.has_external_field = 1;
    plan.external_field_am[0] = 0.0;
    plan.external_field_am[1] = 2.0e5;
    plan.external_field_am[2] = 1.0e5;
    plan.demag_solver.solver = FULLMAG_FEM_LINEAR_SOLVER_CG;
    plan.demag_solver.preconditioner = FULLMAG_FEM_PRECONDITIONER_AMG;
    plan.demag_solver.relative_tolerance = 1.0e-11;
    plan.demag_solver.has_absolute_tolerance = 0;
    plan.demag_solver.absolute_tolerance = 0.0;
    plan.demag_solver.max_iterations = 500u;
    plan.demag_solver.print_level = 0u;
    plan.air_box_factor = 1.0;
    plan.demag_realization = FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
    plan.poisson_boundary_marker = static_cast<int>(boundary_marker);
    plan.robin_beta_mode = 2;
    plan.robin_beta_factor = 2.0;
    plan.initial_magnetization_xyz = initial_m.data();
    plan.initial_magnetization_len = static_cast<uint64_t>(initial_m.size());
    plan.dt_seconds = dt_seconds;
    plan.gpu_device_index = 0;
    plan.mfem_device_string = "cuda";
    plan.gpu_demag_mode = FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON;
    plan.eager_initial_effective_field = 1;
    return plan;
}

fullmag_fem_plan_desc_v5 wrap_plan_v5(
    const fullmag_fem_plan_desc &base,
    uint32_t boundary_marker,
    fullmag_fem_gpu_demag_solver_strategy_v1 strategy)
{
    fullmag_fem_plan_desc_v5 v5{};
    v5.abi_version = FULLMAG_FEM_PLAN_DESC_V5_ABI_VERSION;
    v5.struct_size = sizeof(fullmag_fem_plan_desc_v5);
    v5.gpu_demag_solver_strategy = static_cast<uint32_t>(strategy);
    v5.reserved = 0u;
    v5.base.abi_version = FULLMAG_FEM_PLAN_DESC_V4_ABI_VERSION;
    v5.base.struct_size = sizeof(fullmag_fem_plan_desc_v4);
    v5.base.poisson_boundary_marker = boundary_marker;
    v5.base.reserved = 0u;
    v5.base.base.abi_version = FULLMAG_FEM_PLAN_DESC_V3_ABI_VERSION;
    v5.base.base.struct_size = sizeof(fullmag_fem_plan_desc_v3);
    v5.base.base.mixed_body_certificate_v2 = nullptr;
    v5.base.base.base.abi_version = FULLMAG_FEM_PLAN_DESC_V2_ABI_VERSION;
    v5.base.base.base.struct_size = sizeof(fullmag_fem_plan_desc_v2);
    v5.base.base.base.base = base;
    v5.base.base.base.has_rotated_interfacial_dmi = 0;
    v5.base.base.base.rotated_interfacial_dmi_constant = 0.0;
    return v5;
}

fullmag_fem_backend *create_strict_gpu_backend(
    const fullmag_fem_plan_desc &base,
    uint32_t boundary_marker,
    fullmag_fem_gpu_demag_solver_strategy_v1 strategy,
    const fullmag_fem_adaptive_config_v2 *adaptive_v2 = nullptr)
{
    const fullmag_fem_plan_desc_v5 v5 = wrap_plan_v5(base, boundary_marker, strategy);
    fullmag_fem_backend *handle = fullmag_fem_backend_create_v6(&v5, adaptive_v2);
    check(handle != nullptr, "fullmag_fem_backend_create_v6 must succeed for CUDA test fixture");
    check(
        fullmag_fem_backend_set_gpu_execution_request_v1(
            handle, FULLMAG_FEM_GPU_EXECUTION_REQUEST_STRICT_DEVICE) == FULLMAG_FEM_OK,
        "strict device execution request must succeed");
    return handle;
}

double max_abs_diff(const std::vector<double> &a, const std::vector<double> &b)
{
    check(a.size() == b.size(), "vector size mismatch in max_abs_diff");
    double worst = 0.0;
    for (size_t i = 0; i < a.size(); ++i) {
        worst = std::max(worst, std::abs(a[i] - b[i]));
    }
    return worst;
}

std::vector<double> copy_m(fullmag_fem_backend *handle, uint64_t node_count)
{
    std::vector<double> m(static_cast<size_t>(3u * node_count), 0.0);
    check(
        fullmag_fem_backend_copy_field_f64(
            handle, FULLMAG_FEM_OBSERVABLE_M, m.data(), static_cast<uint64_t>(m.size())) ==
            FULLMAG_FEM_OK,
        "copy magnetization field must succeed");
    return m;
}

void test_fsal_policy_and_signature_matrix()
{
    Context ctx{};
    check(!gpu_rk_has_discontinuous_or_host_drive(ctx),
          "default context has no discontinuous/host drives");
    check(gpu_rk_rhs_allows_fsal_k0_reuse(ctx),
          "default deterministic context allows FSAL k0 reuse");
    check(gpu_rk_allows_endpoint_rhs_shortcut(ctx),
          "default non-frozen non-periodic context allows endpoint RHS shortcut");

    // Thermal noise disables both.
    ctx.thermal_brown.temperature = 300.0;
    check(!gpu_rk_rhs_allows_fsal_k0_reuse(ctx),
          "thermal noise must disable FSAL k0 reuse");
    check(!gpu_rk_allows_endpoint_rhs_shortcut(ctx),
          "thermal noise must disable endpoint RHS shortcut");
    ctx.thermal_brown.temperature = 0.0;

    // Stage callbacks disable both.
    ctx.oersted.has_stage_callback = true;
    check(!gpu_rk_rhs_allows_fsal_k0_reuse(ctx),
          "Oersted stage callback must disable FSAL k0 reuse");
    ctx.oersted.has_stage_callback = false;
    ctx.stage_transport.has_stage_callback = true;
    check(!gpu_rk_rhs_allows_fsal_k0_reuse(ctx),
          "transport stage callback must disable FSAL k0 reuse");
    ctx.stage_transport.has_stage_callback = false;

    // Discontinuous & host-expression drives disable both (fail-closed).
    RegionalFieldDriveRuntime drive{};
    drive.waveform.kind = FULLMAG_FEM_TIME_SINUSOIDAL;
    ctx.zeeman.regional_drives.push_back(drive);
    check(!gpu_rk_has_discontinuous_or_host_drive(ctx) &&
              gpu_rk_rhs_allows_fsal_k0_reuse(ctx),
          "continuous SINUSOIDAL regional drive must remain FSAL-eligible");

    ctx.zeeman.regional_drives[0].waveform.kind = FULLMAG_FEM_TIME_SINC_PULSE;
    check(!gpu_rk_has_discontinuous_or_host_drive(ctx) &&
              gpu_rk_rhs_allows_fsal_k0_reuse(ctx),
          "continuous SINC_PULSE regional drive must remain FSAL-eligible");

    ctx.zeeman.regional_drives[0].waveform.kind = FULLMAG_FEM_TIME_PIECEWISE_LINEAR;
    check(!gpu_rk_has_discontinuous_or_host_drive(ctx) &&
              gpu_rk_rhs_allows_fsal_k0_reuse(ctx),
          "continuous PIECEWISE_LINEAR regional drive must remain FSAL-eligible");

    ctx.zeeman.regional_drives[0].waveform.kind = FULLMAG_FEM_TIME_PULSE;
    check(gpu_rk_has_discontinuous_or_host_drive(ctx) &&
              !gpu_rk_rhs_allows_fsal_k0_reuse(ctx) &&
              !gpu_rk_allows_endpoint_rhs_shortcut(ctx),
          "PULSE regional drive must fail closed and disable FSAL");

    ctx.zeeman.regional_drives[0].waveform.kind = FULLMAG_FEM_TIME_HOST_EXPRESSION;
    check(gpu_rk_has_discontinuous_or_host_drive(ctx) &&
              !gpu_rk_rhs_allows_fsal_k0_reuse(ctx) &&
              !gpu_rk_allows_endpoint_rhs_shortcut(ctx),
          "HOST_EXPRESSION regional drive must fail closed and disable FSAL");
    ctx.zeeman.regional_drives.clear();

    ctx.oersted.has_cylinder = true;
    ctx.oersted.time_dep_kind = 1u;
    check(!gpu_rk_has_discontinuous_or_host_drive(ctx) &&
              gpu_rk_rhs_allows_fsal_k0_reuse(ctx),
          "Oersted sinusoidal drive (kind=1) must remain FSAL-eligible");
    ctx.oersted.time_dep_kind = 2u;
    check(gpu_rk_has_discontinuous_or_host_drive(ctx) &&
              !gpu_rk_rhs_allows_fsal_k0_reuse(ctx),
          "Oersted pulse drive (kind=2) must fail closed and disable FSAL");
    ctx.oersted.time_dep_kind = 0u;
    ctx.oersted.has_cylinder = false;

    ctx.sot.enabled = true;
    ctx.sot.envelope_kind = FULLMAG_FEM_TIME_SINUSOIDAL;
    check(!gpu_rk_has_discontinuous_or_host_drive(ctx) &&
              gpu_rk_rhs_allows_fsal_k0_reuse(ctx),
          "SOT sinusoidal envelope must remain FSAL-eligible");
    ctx.sot.envelope_kind = FULLMAG_FEM_TIME_PULSE;
    check(gpu_rk_has_discontinuous_or_host_drive(ctx) &&
              !gpu_rk_rhs_allows_fsal_k0_reuse(ctx),
          "SOT pulse envelope must fail closed and disable FSAL");
    ctx.sot.envelope_kind = FULLMAG_FEM_TIME_CONSTANT;
    ctx.sot.enabled = false;

    // Separation: frozen spins and PBC allow fsal_k0_reuse but disable endpoint shortcut.
    const uint8_t frozen_mask[2] = {1u, 0u};
    const double frozen_ref[6] = {0.0, 0.0, 1.0, 0.0, 0.0, 0.0};
    std::string error;
    check(
        ctx.frozen_spins.import_descriptor(frozen_mask, 2u, frozen_ref, 6u, 2u, 2u, "fp", error),
        "frozen spins descriptor import");
    check(gpu_rk_rhs_allows_fsal_k0_reuse(ctx),
          "frozen spins must allow FSAL k0 reuse");
    check(!gpu_rk_allows_endpoint_rhs_shortcut(ctx),
          "frozen spins must disable RK23/RK45 endpoint RHS shortcut");
    ctx.frozen_spins = {};

    ctx.gpu_state.device.mesh_regions.has_periodic_reduced_nodes = true;
    check(gpu_rk_rhs_allows_fsal_k0_reuse(ctx),
          "periodic reduced mesh must allow FSAL k0 reuse");
    check(!gpu_rk_allows_endpoint_rhs_shortcut(ctx),
          "periodic reduced mesh must disable RK23/RK45 endpoint RHS shortcut");
    ctx.gpu_state.device.mesh_regions.has_periodic_reduced_nodes = false;

    // Expanded operator signature sensitivity.
    const uint64_t base_sig = gpu_rk_fsal_operator_signature(ctx);
    ctx.zeeman.external_field_am[0] = 1.25e4;
    check(gpu_rk_fsal_operator_signature(ctx) != base_sig,
          "operator signature must hash zeeman.external_field_am");
    ctx.zeeman.external_field_am[0] = 0.0;

    ctx.zeeman.stage_start_time_s = 1.0e-9;
    check(gpu_rk_fsal_operator_signature(ctx) != base_sig,
          "operator signature must hash zeeman.stage_start_time_s");
    ctx.zeeman.stage_start_time_s = 0.0;

    ctx.gpu_state.device.relaxation.state_generation += 1u;
    check(gpu_rk_fsal_operator_signature(ctx) != base_sig,
          "operator signature must hash relaxation.state_generation");
    ctx.gpu_state.device.relaxation.state_generation = 0u;

    ctx.stt.zhang_li_enabled = true;
    check(gpu_rk_fsal_operator_signature(ctx) != base_sig,
          "operator signature must hash stt state");
    ctx.stt.zhang_li_enabled = false;

    ctx.sot.enabled = true;
    check(gpu_rk_fsal_operator_signature(ctx) != base_sig,
          "operator signature must hash sot state");
    ctx.sot.enabled = false;

    ctx.oersted.time_dep_kind = 1u;
    check(gpu_rk_fsal_operator_signature(ctx) != base_sig,
          "operator signature must hash oersted.time_dep_kind");
    ctx.oersted.time_dep_kind = 0u;

    ctx.dmi.rotated_interfacial_enabled = true;
    check(gpu_rk_fsal_operator_signature(ctx) != base_sig,
          "operator signature must hash dmi.rotated_interfacial_enabled");
    ctx.dmi.rotated_interfacial_enabled = false;

    check(
        ctx.frozen_spins.import_descriptor(frozen_mask, 2u, frozen_ref, 6u, 2u, 2u, "fp", error),
        "frozen spins re-import for signature check");
    check(gpu_rk_fsal_operator_signature(ctx) != base_sig,
          "operator signature must hash frozen_spins.enabled()");
}

#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK

void test_predictor_kernel_math_and_equal_stage_and_guards()
{
    constexpr uint64_t kRows = 16u;
    constexpr uint64_t kSig = 0xabcdef1234567890ULL;
    std::vector<double> phi0(kRows, 0.0);
    std::vector<double> phi1(kRows, 0.0);
    // Index 0 simulates an essential Dirichlet DOF (0.0 in both accepted potentials).
    for (uint64_t i = 1u; i < kRows; ++i) {
        phi0[i] = 1.5 * static_cast<double>(i) - 0.25;
        phi1[i] = 2.25 * static_cast<double>(i) + 0.5;
    }

    double *d_buf = nullptr;
    check_cuda(cudaMalloc(&d_buf, kRows * sizeof(double)), "cudaMalloc predictor test buf");
    cudaStream_t stream = nullptr;
    check_cuda(cudaStreamCreate(&stream), "cudaStreamCreate predictor test");

    GpuDemagLinearPredictorState predictor{};
    std::string reason;
    bool predicted = false;

    // 1. history_count == 0 -> skip
    check(
        gpu_demag_predictor_apply_warm_start(
            predictor, 1.5, 1.0, kSig, d_buf, kRows, stream, predicted, reason),
        "apply with history_count==0 must succeed as no-op");
    check(!predicted, "history_count==0 must not predict");

    // 2. Commit step 1 -> history_count == 1 -> still skip
    check_cuda(
        cudaMemcpy(d_buf, phi0.data(), kRows * sizeof(double), cudaMemcpyHostToDevice),
        "upload phi0");
    check(
        gpu_demag_predictor_commit_accepted_potential(
            predictor, d_buf, kRows, 1.0, kSig, stream, reason),
        "commit phi0 must succeed");
    check(predictor.history_count == 1u, "after 1 commit history_count must be 1");
    check(
        gpu_demag_predictor_apply_warm_start(
            predictor, 1.5, 1.0, kSig, d_buf, kRows, stream, predicted, reason),
        "apply with history_count==1 must succeed as no-op");
    check(!predicted, "history_count==1 must not predict");

    // 3. Commit step 2 -> history_count == 2 -> exact kernel math & ess_tdof=0 preservation
    check_cuda(
        cudaMemcpy(d_buf, phi1.data(), kRows * sizeof(double), cudaMemcpyHostToDevice),
        "upload phi1");
    check(
        gpu_demag_predictor_commit_accepted_potential(
            predictor, d_buf, kRows, 2.0, kSig, stream, reason),
        "commit phi1 must succeed");
    check(predictor.history_count == 2u, "after 2 commits history_count must be 2");

    // Simulate RK4 attempt starting at t_n = 2.0, dt = 1.0.
    predictor.last_solved_stage_time_s = 2.0;

    // Stage 1 (c1 = 0.5, t_eval = 2.5): must predict alpha = 0.5.
    check(
        gpu_demag_predictor_apply_warm_start(
            predictor, 2.5, 1.0, kSig, d_buf, kRows, stream, predicted, reason),
        "RK4 stage-1 predict must succeed");
    check(predicted, "RK4 stage-1 (t=2.5 > 2.0) must predict");
    check_cuda(cudaStreamSynchronize(stream), "sync stage-1 prediction");
    std::vector<double> out(kRows, 0.0);
    check_cuda(
        cudaMemcpy(out.data(), d_buf, kRows * sizeof(double), cudaMemcpyDeviceToHost),
        "download stage-1 prediction");
    check(out[0] == 0.0, "predictor must preserve exact zero on essential DOF");
    for (uint64_t i = 1u; i < kRows; ++i) {
        const double expected = phi1[i] + 0.5 * (phi1[i] - phi0[i]);
        check(
            std::abs(out[i] - expected) <= 1.0e-14,
            "predictor kernel must match phi_n + alpha*(phi_n - phi_{n-1}) to 1e-14");
    }

    // Stage 2 (c2 = 0.5, t_eval = 2.5): equal-time stage guard MUST NOT overwrite!
    predictor.last_solved_stage_time_s = 2.5;
    std::vector<double> sentinel_stage2(kRows, 999.25);
    sentinel_stage2[0] = 0.0;
    check_cuda(
        cudaMemcpy(d_buf, sentinel_stage2.data(), kRows * sizeof(double), cudaMemcpyHostToDevice),
        "upload stage-2 sentinel");
    check(
        gpu_demag_predictor_apply_warm_start(
            predictor, 2.5, 1.0, kSig, d_buf, kRows, stream, predicted, reason),
        "RK4 stage-2 equal-time guard must succeed as no-op");
    check(!predicted, "RK4 stage-2 (t=2.5 <= last_solved=2.5) must NOT predict");
    check_cuda(cudaStreamSynchronize(stream), "sync stage-2 guard");
    check_cuda(
        cudaMemcpy(out.data(), d_buf, kRows * sizeof(double), cudaMemcpyDeviceToHost),
        "download stage-2 sentinel");
    check(max_abs_diff(out, sentinel_stage2) == 0.0,
          "equal-time RK4 stage-2 must preserve higher-order stage-1 solution");

    // Stage 3 (c3 = 1.0, t_eval = 3.0): strictly advancing -> predicts alpha = 1.0.
    check(
        gpu_demag_predictor_apply_warm_start(
            predictor, 3.0, 1.0, kSig, d_buf, kRows, stream, predicted, reason),
        "RK4 stage-3 predict must succeed");
    check(predicted, "RK4 stage-3 (t=3.0 > 2.5) must predict");
    check_cuda(cudaStreamSynchronize(stream), "sync stage-3 prediction");
    check_cuda(
        cudaMemcpy(out.data(), d_buf, kRows * sizeof(double), cudaMemcpyDeviceToHost),
        "download stage-3 prediction");
    for (uint64_t i = 0u; i < kRows; ++i) {
        const double expected = phi1[i] + 1.0 * (phi1[i] - phi0[i]);
        check(
            std::abs(out[i] - expected) <= 1.0e-14,
            "RK4 stage-3 alpha=1.0 extrapolation must match to 1e-14");
    }

    // Final refresh (c = 1.0, t_eval = 3.0): equal-time stage guard MUST NOT overwrite!
    predictor.last_solved_stage_time_s = 3.0;
    std::vector<double> sentinel_final(kRows, 777.5);
    sentinel_final[0] = 0.0;
    check_cuda(
        cudaMemcpy(d_buf, sentinel_final.data(), kRows * sizeof(double), cudaMemcpyHostToDevice),
        "upload final-refresh sentinel");
    check(
        gpu_demag_predictor_apply_warm_start(
            predictor, 3.0, 1.0, kSig, d_buf, kRows, stream, predicted, reason),
        "RK4 final-refresh equal-time guard must succeed as no-op");
    check(!predicted, "RK4 final refresh (t=3.0 <= last_solved=3.0) must NOT predict");
    check_cuda(
        cudaMemcpy(out.data(), d_buf, kRows * sizeof(double), cudaMemcpyDeviceToHost),
        "download final-refresh sentinel");
    check(max_abs_diff(out, sentinel_final) == 0.0,
          "equal-time RK4 final refresh must preserve O(dt^3) stage-3 solution");

    // 4. dt_ratio = 2.5 > 2.0 guard -> skip
    predictor.last_solved_stage_time_s = 2.0;
    check(
        gpu_demag_predictor_apply_warm_start(
            predictor, 3.25, 2.5, kSig, d_buf, kRows, stream, predicted, reason),
        "dt_ratio > 2.0 guard must succeed as no-op");
    check(!predicted, "dt_ratio=2.5 > 2.0 must disable linear extrapolation");

    // 5. Operator signature mismatch invalidates predictor
    check(
        gpu_demag_predictor_apply_warm_start(
            predictor, 2.5, 1.0, kSig ^ 1ULL, d_buf, kRows, stream, predicted, reason),
        "signature mismatch must succeed as fail-closed invalidation");
    check(!predicted && predictor.history_count == 0u,
          "signature mismatch must invalidate predictor history");

    gpu_demag_predictor_destroy(predictor);
    check(predictor.d_phi_curr == nullptr && predictor.d_phi_prev == nullptr &&
              predictor.capacity == 0u,
          "predictor destroy must free buffers and clear capacity");
    cudaStreamDestroy(stream);
    cudaFree(d_buf);
}

void test_heun_and_rk4_fsal_demag_reduction_and_parity()
{
    const OwnedTetMesh cube = make_kuhn_cube_mesh(2u, 2u, 2u, 20.0e-9, 20.0e-9, 20.0e-9, 99u);
    const std::vector<double> m0 = make_smooth_magnetization(cube, 20.0e-9);
    constexpr double kDt = 1.0e-13;

    // Part A: Exchange + Zeeman exact FSAL parity <= 1e-14 for Heun and RK4.
    for (const auto [integrator, first_rhs, reused_rhs] : std::array<std::tuple<fullmag_fem_integrator, uint32_t, uint32_t>, 2>{{
             {FULLMAG_FEM_INTEGRATOR_HEUN, 3u, 2u},
             {FULLMAG_FEM_INTEGRATOR_RK4, 5u, 4u},
         }}) {
        const auto plan = make_base_gpu_plan(cube, m0, integrator, kDt, false, 99u);
        auto *fsal_on = create_strict_gpu_backend(
            plan, 99u, FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_CG_AMG);
        auto *fsal_off = create_strict_gpu_backend(
            plan, 99u, FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_CG_AMG);

        for (int step = 0; step < 5; ++step) {
            fullmag_fem_step_stats on_stats{};
            fullmag_fem_step_stats off_stats{};
            check(fullmag_fem_backend_invalidate_fsal(fsal_off) == FULLMAG_FEM_OK,
                  "invalidate_fsal on FSAL-OFF baseline must succeed");
            check(fullmag_fem_backend_step(fsal_on, kDt, &on_stats) == FULLMAG_FEM_OK,
                  "FSAL-ON step must succeed");
            check(fullmag_fem_backend_step(fsal_off, kDt, &off_stats) == FULLMAG_FEM_OK,
                  "FSAL-OFF step must succeed");
            check(off_stats.rhs_evaluations == first_rhs && off_stats.fsal_reused == 0,
                  "FSAL-OFF baseline must never reuse k0");
            if (step == 0) {
                check(on_stats.rhs_evaluations == first_rhs && on_stats.fsal_reused == 0,
                      "step 1 must compute fresh k0");
            } else {
                check(on_stats.rhs_evaluations == reused_rhs && on_stats.fsal_reused == 1,
                      "steps 2..5 must reuse FSAL k0 for Heun/RK4");
            }
        }
        const auto m_on = copy_m(fsal_on, cube.node_count());
        const auto m_off = copy_m(fsal_off, cube.node_count());
        check(max_abs_diff(m_on, m_off) <= 1.0e-14,
              "Heun/RK4 FSAL-ON vs FSAL-OFF magnetization parity must be <= 1e-14");
        fullmag_fem_backend_destroy(fsal_on);
        fullmag_fem_backend_destroy(fsal_off);
    }

    // Part B: Poisson CG/AMG demag solve count reduction (3->2 Heun, 5->4 RK4) + parity.
    for (const auto [integrator, first_solves, reused_solves] : std::array<std::tuple<fullmag_fem_integrator, uint32_t, uint32_t>, 2>{{
             {FULLMAG_FEM_INTEGRATOR_HEUN, 3u, 2u},
             {FULLMAG_FEM_INTEGRATOR_RK4, 5u, 4u},
         }}) {
        const auto plan = make_base_gpu_plan(cube, m0, integrator, kDt, true, 99u);
        auto *fsal_on = create_strict_gpu_backend(
            plan, 99u, FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_CG_AMG);
        auto *fsal_off = create_strict_gpu_backend(
            plan, 99u, FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_CG_AMG);

        for (int step = 0; step < 5; ++step) {
            fullmag_fem_step_stats on_stats{};
            fullmag_fem_step_stats off_stats{};
            check(fullmag_fem_backend_invalidate_fsal(fsal_off) == FULLMAG_FEM_OK,
                  "invalidate_fsal on demag FSAL-OFF baseline must succeed");
            check(fullmag_fem_backend_step(fsal_on, kDt, &on_stats) == FULLMAG_FEM_OK,
                  "demag FSAL-ON step must succeed");
            check(fullmag_fem_backend_step(fsal_off, kDt, &off_stats) == FULLMAG_FEM_OK,
                  "demag FSAL-OFF step must succeed");
            check(off_stats.demag_solve_count == first_solves && off_stats.fsal_reused == 0,
                  "demag FSAL-OFF baseline must execute full solve count");
            if (step == 0) {
                check(on_stats.demag_solve_count == first_solves &&
                          on_stats.rhs_evaluations == first_solves &&
                          on_stats.fsal_reused == 0,
                      "demag step 1 must execute full solve count");
            } else {
                check(on_stats.demag_solve_count == reused_solves &&
                          on_stats.rhs_evaluations == reused_solves &&
                          on_stats.fsal_reused == 1,
                      "demag steps 2..5 must reduce solve count (Heun 3->2, RK4 5->4)");
            }
        }
        const auto m_on = copy_m(fsal_on, cube.node_count());
        const auto m_off = copy_m(fsal_off, cube.node_count());
        check(max_abs_diff(m_on, m_off) <= 1.0e-10,
              "Heun/RK4 Poisson demag FSAL-ON vs FSAL-OFF parity must hold within solver rtol");
        fullmag_fem_backend_destroy(fsal_on);
        fullmag_fem_backend_destroy(fsal_off);
    }
}

void test_drives_continuous_vs_pulse_and_invalidation()
{
    const OwnedTetMesh cube = make_kuhn_cube_mesh(2u, 2u, 2u, 20.0e-9, 20.0e-9, 20.0e-9, 99u);
    const std::vector<double> m0 = make_smooth_magnetization(cube, 20.0e-9);
    constexpr double kDt = 1.0e-13;

    // 1. Continuous SINUSOIDAL regional drive -> step 2 reuses FSAL, then mutations invalidate.
    fullmag_fem_regional_field_drive_desc sin_drive{};
    sin_drive.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
    sin_drive.struct_size = sizeof(sin_drive);
    sin_drive.stable_id_hash = 0x1111u;
    sin_drive.target.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
    sin_drive.target.struct_size = sizeof(sin_drive.target);
    sin_drive.target.kind = FULLMAG_FEM_FIELD_TARGET_GLOBAL;
    sin_drive.spatial_profile.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
    sin_drive.spatial_profile.struct_size = sizeof(sin_drive.spatial_profile);
    sin_drive.spatial_profile.kind = FULLMAG_FEM_SPATIAL_PROFILE_UNIFORM;
    sin_drive.amplitude_b_t = 0.05;
    sin_drive.direction[0] = 0.0;
    sin_drive.direction[1] = 1.0;
    sin_drive.direction[2] = 0.0;
    sin_drive.waveform.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
    sin_drive.waveform.struct_size = sizeof(sin_drive.waveform);
    sin_drive.waveform.kind = FULLMAG_FEM_TIME_SINUSOIDAL;
    sin_drive.waveform.parameters.sinusoidal.frequency_hz = 1.0e9;
    sin_drive.waveform.parameters.sinusoidal.phase_rad = 0.0;
    sin_drive.waveform.parameters.sinusoidal.offset = 0.0;
    sin_drive.time_origin = FULLMAG_FEM_TIME_STAGE_LOCAL;

    auto sin_plan = make_base_gpu_plan(cube, m0, FULLMAG_FEM_INTEGRATOR_RK4, kDt, false, 99u);
    sin_plan.regional_field_drives = &sin_drive;
    sin_plan.regional_field_drive_count = 1u;
    sin_plan.stage_start_time_s = 0.0;

    auto *sin_backend = create_strict_gpu_backend(
        sin_plan, 99u, FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_CG_AMG);
    fullmag_fem_step_stats stats{};
    check(fullmag_fem_backend_step(sin_backend, kDt, &stats) == FULLMAG_FEM_OK,
          "SINUSOIDAL step 1 must succeed");
    check(stats.fsal_reused == 0, "SINUSOIDAL step 1 must not reuse FSAL");
    check(fullmag_fem_backend_step(sin_backend, kDt, &stats) == FULLMAG_FEM_OK,
          "SINUSOIDAL step 2 must succeed");
    check(stats.fsal_reused == 1 && stats.rhs_evaluations == 4u,
          "SINUSOIDAL step 2 must reuse FSAL k0");

    // Mutate current_time -> time mismatch forces fresh k0.
    sin_backend->context.state.current_time += 5.0e-15;
    check(fullmag_fem_backend_step(sin_backend, kDt, &stats) == FULLMAG_FEM_OK,
          "step after current_time shift must succeed");
    check(stats.fsal_reused == 0 && stats.rhs_evaluations == 5u,
          "current_time mismatch must invalidate FSAL reuse");

    // Next step reuses again, then mutate external_field_am -> signature mismatch.
    check(fullmag_fem_backend_step(sin_backend, kDt, &stats) == FULLMAG_FEM_OK,
          "step before external_field_am mutation must succeed");
    check(stats.fsal_reused == 1, "FSAL reuse must recover on steady step");
    sin_backend->context.zeeman.external_field_am[0] = 5.0e4;
    check(fullmag_fem_backend_step(sin_backend, kDt, &stats) == FULLMAG_FEM_OK,
          "step after external_field_am mutation must succeed");
    check(stats.fsal_reused == 0 && stats.rhs_evaluations == 5u,
          "external_field_am mutation must invalidate FSAL via operator signature");

    // Mutate stage_start_time_s -> signature mismatch.
    sin_backend->context.zeeman.stage_start_time_s = 1.0e-12;
    check(fullmag_fem_backend_step(sin_backend, kDt, &stats) == FULLMAG_FEM_OK,
          "step after stage_start_time_s mutation must succeed");
    check(stats.fsal_reused == 0 && stats.rhs_evaluations == 5u,
          "stage_start_time_s mutation must invalidate FSAL via operator signature");

    // Mutate relaxation.state_generation -> signature mismatch.
    sin_backend->context.gpu_state.device.relaxation.state_generation += 1u;
    check(fullmag_fem_backend_step(sin_backend, kDt, &stats) == FULLMAG_FEM_OK,
          "step after state_generation bump must succeed");
    check(stats.fsal_reused == 0 && stats.rhs_evaluations == 5u,
          "relaxation.state_generation bump must invalidate FSAL via operator signature");
    fullmag_fem_backend_destroy(sin_backend);

    // 2. Discontinuous PULSE regional drive -> never reuses FSAL.
    auto pulse_drive = sin_drive;
    pulse_drive.waveform.kind = FULLMAG_FEM_TIME_PULSE;
    pulse_drive.waveform.parameters.pulse.t_on_s = 0.0;
    pulse_drive.waveform.parameters.pulse.t_off_s = 1.0e-12;
    auto pulse_plan = make_base_gpu_plan(cube, m0, FULLMAG_FEM_INTEGRATOR_HEUN, kDt, false, 99u);
    pulse_plan.regional_field_drives = &pulse_drive;
    pulse_plan.regional_field_drive_count = 1u;
    auto *pulse_backend = create_strict_gpu_backend(
        pulse_plan, 99u, FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_CG_AMG);
    check(fullmag_fem_backend_step(pulse_backend, kDt, &stats) == FULLMAG_FEM_OK,
          "PULSE regional step 1");
    check(fullmag_fem_backend_step(pulse_backend, kDt, &stats) == FULLMAG_FEM_OK,
          "PULSE regional step 2");
    check(stats.fsal_reused == 0 && stats.rhs_evaluations == 3u,
          "PULSE regional drive must disable FSAL reuse on step 2");
    fullmag_fem_backend_destroy(pulse_backend);

    // 3. Oersted pulse (time_dep_kind == 2) -> never reuses FSAL.
    auto oersted_plan = make_base_gpu_plan(cube, m0, FULLMAG_FEM_INTEGRATOR_HEUN, kDt, false, 99u);
    oersted_plan.has_oersted_cylinder = 1;
    oersted_plan.oersted_current = 1.0e-3;
    oersted_plan.oersted_radius = 5.0e-9;
    oersted_plan.oersted_center[0] = 10.0e-9;
    oersted_plan.oersted_center[1] = 10.0e-9;
    oersted_plan.oersted_center[2] = 10.0e-9;
    oersted_plan.oersted_axis[0] = 0.0;
    oersted_plan.oersted_axis[1] = 0.0;
    oersted_plan.oersted_axis[2] = 1.0;
    oersted_plan.oersted_time_dep_kind = 2u;
    oersted_plan.oersted_time_dep_t_on = 0.0;
    oersted_plan.oersted_time_dep_t_off = 1.0e-12;
    auto *oersted_backend = create_strict_gpu_backend(
        oersted_plan, 99u, FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_CG_AMG);
    check(fullmag_fem_backend_step(oersted_backend, kDt, &stats) == FULLMAG_FEM_OK,
          "Oersted pulse step 1");
    check(fullmag_fem_backend_step(oersted_backend, kDt, &stats) == FULLMAG_FEM_OK,
          "Oersted pulse step 2");
    check(stats.fsal_reused == 0 && stats.rhs_evaluations == 3u,
          "Oersted pulse (time_dep_kind==2) must disable FSAL reuse");
    fullmag_fem_backend_destroy(oersted_backend);

    // 4. SOT pulse -> never reuses FSAL.
    auto sot_plan = make_base_gpu_plan(cube, m0, FULLMAG_FEM_INTEGRATOR_HEUN, kDt, false, 99u);
    sot_plan.has_prescribed_sot = 1;
    sot_plan.sot_formula_version = FULLMAG_FEM_SOT_FORMULA_PRESCRIBED_V1;
    sot_plan.sot_current_density_am2 = 1.0e11;
    sot_plan.sot_xi_dl = 0.1;
    sot_plan.sot_xi_fl = 0.02;
    sot_plan.sot_thickness = 2.0e-9;
    sot_plan.sot_envelope_value = 1.0;
    sot_plan.sot_sigma[0] = 0.0;
    sot_plan.sot_sigma[1] = 1.0;
    sot_plan.sot_sigma[2] = 0.0;
    sot_plan.sot_envelope.abi_version = FULLMAG_FEM_SOT_ENVELOPE_ABI_VERSION;
    sot_plan.sot_envelope.struct_size = sizeof(sot_plan.sot_envelope);
    sot_plan.sot_envelope.kind = FULLMAG_FEM_TIME_PULSE;
    sot_plan.sot_envelope.time_origin = FULLMAG_FEM_TIME_STAGE_LOCAL;
    sot_plan.sot_envelope.amplitude = 1.0;
    sot_plan.sot_envelope.t_on_s = 0.0;
    sot_plan.sot_envelope.t_off_s = 1.0e-12;
    auto *sot_backend = create_strict_gpu_backend(
        sot_plan, 99u, FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_CG_AMG);
    check(fullmag_fem_backend_step(sot_backend, kDt, &stats) == FULLMAG_FEM_OK,
          "SOT pulse step 1");
    check(fullmag_fem_backend_step(sot_backend, kDt, &stats) == FULLMAG_FEM_OK,
          "SOT pulse step 2");
    check(stats.fsal_reused == 0 && stats.rhs_evaluations == 3u,
          "SOT pulse must disable FSAL reuse");
    fullmag_fem_backend_destroy(sot_backend);
}

void test_frozen_spins_and_pbc_fsal_and_endpoint_separation()
{
    constexpr double kDt = 1.0e-13;

    // 1. Frozen spins: Heun & RK4 reuse FSAL k0 with <= 1e-14 parity.
    const OwnedTetMesh cube = make_kuhn_cube_mesh(2u, 2u, 2u, 20.0e-9, 20.0e-9, 20.0e-9, 99u);
    std::vector<double> m0 = make_smooth_magnetization(cube, 20.0e-9);
    m0[0] = 0.36;
    m0[1] = 0.48;
    m0[2] = 0.80;
    std::vector<uint8_t> frozen_mask(static_cast<size_t>(cube.node_count()), 0u);
    frozen_mask[0] = 1u;
    std::vector<double> frozen_ref(m0.size(), 0.0);
    frozen_ref[0] = 0.36;
    frozen_ref[1] = 0.48;
    frozen_ref[2] = 0.80;

    for (const auto [integrator, first_rhs, reused_rhs] : std::array<std::tuple<fullmag_fem_integrator, uint32_t, uint32_t>, 2>{{
             {FULLMAG_FEM_INTEGRATOR_HEUN, 3u, 2u},
             {FULLMAG_FEM_INTEGRATOR_RK4, 5u, 4u},
         }}) {
        auto plan = make_base_gpu_plan(cube, m0, integrator, kDt, false, 99u);
        plan.frozen_mask = frozen_mask.data();
        plan.frozen_mask_len = static_cast<uint64_t>(frozen_mask.size());
        plan.frozen_reference_xyz = frozen_ref.data();
        plan.frozen_reference_len = static_cast<uint64_t>(frozen_ref.size());

        auto *on_backend = create_strict_gpu_backend(
            plan, 99u, FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_CG_AMG);
        auto *off_backend = create_strict_gpu_backend(
            plan, 99u, FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_CG_AMG);

        check(gpu_rk_rhs_allows_fsal_k0_reuse(on_backend->context),
              "frozen spins must allow Heun/RK4 FSAL k0 reuse");
        check(!gpu_rk_allows_endpoint_rhs_shortcut(on_backend->context),
              "frozen spins must disable endpoint RHS shortcut");

        for (int step = 0; step < 3; ++step) {
            fullmag_fem_step_stats on_stats{};
            fullmag_fem_step_stats off_stats{};
            check(fullmag_fem_backend_invalidate_fsal(off_backend) == FULLMAG_FEM_OK,
                  "frozen FSAL-OFF invalidate");
            check(fullmag_fem_backend_step(on_backend, kDt, &on_stats) == FULLMAG_FEM_OK,
                  "frozen FSAL-ON step");
            check(fullmag_fem_backend_step(off_backend, kDt, &off_stats) == FULLMAG_FEM_OK,
                  "frozen FSAL-OFF step");
            if (step == 0) {
                check(on_stats.fsal_reused == 0 && on_stats.rhs_evaluations == first_rhs,
                      "frozen step 1 must compute k0");
            } else {
                check(on_stats.fsal_reused == 1 && on_stats.rhs_evaluations == reused_rhs,
                      "frozen steps 2..3 must reuse FSAL k0");
            }
        }
        const auto m_on = copy_m(on_backend, cube.node_count());
        const auto m_off = copy_m(off_backend, cube.node_count());
        check(std::memcmp(m_on.data(), frozen_ref.data(), 3u * sizeof(double)) == 0,
              "frozen node 0 must stay bitwise pinned under FSAL reuse");
        check(max_abs_diff(m_on, m_off) <= 1.0e-14,
              "frozen spins Heun/RK4 FSAL-ON vs FSAL-OFF parity must be <= 1e-14");
        fullmag_fem_backend_destroy(on_backend);
        fullmag_fem_backend_destroy(off_backend);
    }

    // 2. Frozen spins + adaptive RK23 & RK45: endpoint_valid MUST NEVER be set,
    //    endpoint_cache_invalidations == 0, endpoint_cache_hits == 0, while
    //    fsal_reused == 1 on steps 2..3!
    fullmag_fem_adaptive_config_v2 adaptive{};
    adaptive.abi_version = FULLMAG_FEM_ADAPTIVE_CONFIG_V2_ABI_VERSION;
    adaptive.struct_size = sizeof(adaptive);
    adaptive.base.atol = 1.0e-6;
    adaptive.base.rtol = 1.0e-6;
    adaptive.base.dt_initial = kDt;
    adaptive.base.dt_min = 1.0e-16;
    adaptive.base.dt_max = 1.0e-12;
    adaptive.base.safety = 0.9;
    adaptive.base.growth_limit = 2.0;
    adaptive.base.shrink_limit = 0.2;
    adaptive.base.max_reject = 8u;

    for (const fullmag_fem_integrator integrator : {
             FULLMAG_FEM_INTEGRATOR_RK23_BS,
             FULLMAG_FEM_INTEGRATOR_RK45_DP54,
         }) {
        auto plan = make_base_gpu_plan(cube, m0, integrator, kDt, false, 99u);
        plan.frozen_mask = frozen_mask.data();
        plan.frozen_mask_len = static_cast<uint64_t>(frozen_mask.size());
        plan.frozen_reference_xyz = frozen_ref.data();
        plan.frozen_reference_len = static_cast<uint64_t>(frozen_ref.size());
        auto *backend = create_strict_gpu_backend(
            plan, 99u, FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_CG_AMG, &adaptive);
        check(!gpu_rk_allows_endpoint_rhs_shortcut(backend->context),
              "RK23/RK45 + frozen_spins must disable endpoint RHS shortcut");
        for (int step = 0; step < 3; ++step) {
            fullmag_fem_step_stats stats{};
            check(fullmag_fem_backend_step(backend, kDt, &stats) == FULLMAG_FEM_OK,
                  "RK23/RK45 + frozen_spins step must succeed");
            check(!backend->context.gpu_state.device.rk.endpoint_valid,
                  "RK23/RK45 + frozen_spins must never leave endpoint_valid=true");
            if (step == 0) {
                check(stats.fsal_reused == 0, "RK23/RK45 + frozen step 1 fsal_reused==0");
            } else {
                check(stats.fsal_reused == 1,
                      "RK23/RK45 + frozen steps 2..3 must reuse post-projection k0");
            }
        }
        const auto perf = gpu_performance_snapshot(
            backend->context.gpu_state.performance_counters);
        check(perf.accepted_endpoint_cache_invalidations == 0u,
              "RK23/RK45 + frozen_spins must have zero endpoint_cache_invalidations");
        check(perf.accepted_endpoint_cache_hits == 0u,
              "RK23/RK45 + frozen_spins must have zero endpoint_cache_hits");
        const auto m_out = copy_m(backend, cube.node_count());
        check(std::memcmp(m_out.data(), frozen_ref.data(), 3u * sizeof(double)) == 0,
              "RK23/RK45 + frozen node 0 must remain bitwise pinned");
        fullmag_fem_backend_destroy(backend);
    }

    // 3. Periodic (PBC) mesh + Heun & RK4: FSAL k0 reuse ON from step 2, parity <= 1e-14.
    const OwnedTetMesh pbc_mesh =
        make_x_periodic_kuhn_cube_mesh(2u, 2u, 2u, 20.0e-9, 20.0e-9, 20.0e-9, 99u);
    const std::vector<double> pbc_m0 = make_x_periodic_magnetization(pbc_mesh, 20.0e-9);
    for (const auto [integrator, first_rhs, reused_rhs] : std::array<std::tuple<fullmag_fem_integrator, uint32_t, uint32_t>, 2>{{
             {FULLMAG_FEM_INTEGRATOR_HEUN, 3u, 2u},
             {FULLMAG_FEM_INTEGRATOR_RK4, 5u, 4u},
         }}) {
        const auto plan = make_base_gpu_plan(pbc_mesh, pbc_m0, integrator, kDt, false, 99u);
        auto *on_backend = create_strict_gpu_backend(
            plan, 99u, FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_CG_AMG);
        auto *off_backend = create_strict_gpu_backend(
            plan, 99u, FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_CG_AMG);
        check(on_backend->context.gpu_state.device.mesh_regions.has_periodic_reduced_nodes,
              "PBC fixture must activate periodic reduced nodes on GPU");
        check(gpu_rk_rhs_allows_fsal_k0_reuse(on_backend->context),
              "PBC must allow Heun/RK4 FSAL k0 reuse");
        check(!gpu_rk_allows_endpoint_rhs_shortcut(on_backend->context),
              "PBC must disable RK23/RK45 endpoint RHS shortcut");
        for (int step = 0; step < 3; ++step) {
            fullmag_fem_step_stats on_stats{};
            fullmag_fem_step_stats off_stats{};
            check(fullmag_fem_backend_invalidate_fsal(off_backend) == FULLMAG_FEM_OK,
                  "PBC FSAL-OFF invalidate");
            check(fullmag_fem_backend_step(on_backend, kDt, &on_stats) == FULLMAG_FEM_OK,
                  "PBC FSAL-ON step");
            check(fullmag_fem_backend_step(off_backend, kDt, &off_stats) == FULLMAG_FEM_OK,
                  "PBC FSAL-OFF step");
            if (step == 0) {
                check(on_stats.fsal_reused == 0 && on_stats.rhs_evaluations == first_rhs,
                      "PBC step 1 must compute k0");
            } else {
                check(on_stats.fsal_reused == 1 && on_stats.rhs_evaluations == reused_rhs,
                      "PBC steps 2..3 must reuse FSAL k0");
            }
        }
        const auto m_on = copy_m(on_backend, pbc_mesh.node_count());
        const auto m_off = copy_m(off_backend, pbc_mesh.node_count());
        check(max_abs_diff(m_on, m_off) <= 1.0e-14,
              "PBC Heun/RK4 FSAL-ON vs FSAL-OFF parity must be <= 1e-14");
        fullmag_fem_backend_destroy(on_backend);
        fullmag_fem_backend_destroy(off_backend);
    }
}

void test_transaction_rollback_during_final_field_refresh()
{
    const OwnedTetMesh cube = make_kuhn_cube_mesh(2u, 2u, 2u, 20.0e-9, 20.0e-9, 20.0e-9, 99u);
    const std::vector<double> m0 = make_smooth_magnetization(cube, 20.0e-9);
    constexpr double kDt = 1.0e-13;
    const auto plan = make_base_gpu_plan(cube, m0, FULLMAG_FEM_INTEGRATOR_RK4, kDt, true, 99u);
    auto *backend = create_strict_gpu_backend(
        plan, 99u, FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_CG_AMG);

    // Prime 2 accepted steps so both FSAL and 2-step predictor history are active.
    fullmag_fem_step_stats stats{};
    check(fullmag_fem_backend_step(backend, kDt, &stats) == FULLMAG_FEM_OK, "rollback prime step 1");
    check(fullmag_fem_backend_step(backend, kDt, &stats) == FULLMAG_FEM_OK, "rollback prime step 2");

    auto &ctx = backend->context;
    const auto &rk = ctx.gpu_state.device.rk;
    const auto &pred = ctx.gpu_state.device.demag_poisson.predictor;
    check(rk.fsal_valid && rk.fsal_operator_signature != 0u,
          "FSAL state must be populated after 2 accepted steps");
    check(pred.history_count == 2u && pred.d_phi_curr != nullptr && pred.d_phi_prev != nullptr,
          "predictor history must have 2 accepted potentials after 2 Krylov steps");

    const double saved_fsal_time = rk.fsal_time_seconds;
    const uint64_t saved_fsal_sig = rk.fsal_operator_signature;
    const double *saved_curr_ptr = pred.d_phi_curr;
    const double *saved_prev_ptr = pred.d_phi_prev;
    const uint32_t saved_hist = pred.history_count;
    const double saved_t_curr = pred.t_curr;
    const double saved_t_prev = pred.t_prev;
    const uint64_t saved_pred_sig = pred.operator_signature;
    const double saved_last_stage_t = pred.last_solved_stage_time_s;
    const uint64_t rows = pred.capacity;
    std::vector<double> saved_curr_vals(static_cast<size_t>(rows), 0.0);
    std::vector<double> saved_prev_vals(static_cast<size_t>(rows), 0.0);
    check_cuda(cudaDeviceSynchronize(), "sync before capturing predictor device snapshots");
    check_cuda(
        cudaMemcpy(saved_curr_vals.data(), pred.d_phi_curr, rows * sizeof(double), cudaMemcpyDeviceToHost),
        "copy d_phi_curr before failpoint");
    check_cuda(
        cudaMemcpy(saved_prev_vals.data(), pred.d_phi_prev, rows * sizeof(double), cudaMemcpyDeviceToHost),
        "copy d_phi_prev before failpoint");

    ctx.stepper.failure_injection.next = RkStepFailurePoint::DuringFinalFieldRefresh;
    check(
        fullmag_fem_backend_step(backend, kDt, &stats) != FULLMAG_FEM_OK,
        "DuringFinalFieldRefresh failpoint must trigger step failure and rollback");

    check(rk.fsal_valid &&
              rk.fsal_time_seconds == saved_fsal_time &&
              rk.fsal_operator_signature == saved_fsal_sig,
          "rollback after DuringFinalFieldRefresh must restore exact FSAL metadata");
    check(pred.d_phi_curr == saved_curr_ptr && pred.d_phi_prev == saved_prev_ptr,
          "rollback after DuringFinalFieldRefresh must not swap predictor device pointers");
    check(pred.history_count == saved_hist &&
              pred.t_curr == saved_t_curr &&
              pred.t_prev == saved_t_prev &&
              pred.operator_signature == saved_pred_sig &&
              pred.last_solved_stage_time_s == saved_last_stage_t,
          "rollback after DuringFinalFieldRefresh must restore exact predictor metadata");

    std::vector<double> after_curr_vals(static_cast<size_t>(rows), 0.0);
    std::vector<double> after_prev_vals(static_cast<size_t>(rows), 0.0);
    check_cuda(cudaDeviceSynchronize(), "sync after rollback");
    check_cuda(
        cudaMemcpy(after_curr_vals.data(), pred.d_phi_curr, rows * sizeof(double), cudaMemcpyDeviceToHost),
        "copy d_phi_curr after rollback");
    check_cuda(
        cudaMemcpy(after_prev_vals.data(), pred.d_phi_prev, rows * sizeof(double), cudaMemcpyDeviceToHost),
        "copy d_phi_prev after rollback");
    check(max_abs_diff(saved_curr_vals, after_curr_vals) == 0.0 &&
              max_abs_diff(saved_prev_vals, after_prev_vals) == 0.0,
          "rollback after DuringFinalFieldRefresh must leave predictor device buffers untouched");

    fullmag_fem_backend_destroy(backend);
}

void test_non_rk_purpose_and_invalidate_fsal_clear_predictor()
{
    const OwnedTetMesh cube = make_kuhn_cube_mesh(2u, 2u, 2u, 20.0e-9, 20.0e-9, 20.0e-9, 99u);
    const std::vector<double> m0 = make_smooth_magnetization(cube, 20.0e-9);
    constexpr double kDt = 1.0e-13;
    const auto plan = make_base_gpu_plan(cube, m0, FULLMAG_FEM_INTEGRATOR_HEUN, kDt, true, 99u);
    auto *backend = create_strict_gpu_backend(
        plan, 99u, FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_CG_AMG);
    auto &ctx = backend->context;
    auto &pred = ctx.gpu_state.device.demag_poisson.predictor;

    auto prime_two_steps = [&]() {
        fullmag_fem_step_stats stats{};
        check(fullmag_fem_backend_step(backend, kDt, &stats) == FULLMAG_FEM_OK, "prime step 1");
        check(fullmag_fem_backend_step(backend, kDt, &stats) == FULLMAG_FEM_OK, "prime step 2");
        check(pred.history_count == 2u, "primed predictor must have history_count==2");
    };

    // 1. fullmag_fem_backend_invalidate_fsal clears predictor.
    prime_two_steps();
    check(fullmag_fem_backend_invalidate_fsal(backend) == FULLMAG_FEM_OK,
          "invalidate_fsal must succeed");
    check(!ctx.gpu_state.device.rk.fsal_valid && pred.history_count == 0u,
          "fullmag_fem_backend_invalidate_fsal must invalidate both FSAL and predictor");

    // 2. Every non-RK purpose auto-invalidates predictor in stage_compute.cpp.
    for (const GpuDemagSolvePurpose purpose : {
             GpuDemagSolvePurpose::RelaxationTrial,
             GpuDemagSolvePurpose::ValidationOracle,
             GpuDemagSolvePurpose::FrequencyTangent,
             GpuDemagSolvePurpose::ObservableRefresh,
         }) {
        prime_two_steps();
        GpuDemagApplyRequest req{};
        req.reset_initial_solution = false;
        req.evaluation_mode = GpuDemagEvaluationMode::FieldOnly;
        req.purpose = purpose;
        std::string reason;
        check_msg(
            compute_device_demag_for_device_stage(
                ctx,
                ctx.gpu_state.device.magnetization.m,
                ctx.gpu_state.cuda.compute_stream,
                req,
                reason),
            "non-RK demag stage solve failed: " + reason);
        check(pred.history_count == 0u,
              "non-RK demag purpose must auto-invalidate predictor history");
    }

    // 3. reset_initial_solution == true invalidates predictor even for RK purpose.
    prime_two_steps();
    {
        GpuDemagApplyRequest req{};
        req.reset_initial_solution = true;
        req.evaluation_mode = GpuDemagEvaluationMode::FieldOnly;
        req.purpose = GpuDemagSolvePurpose::IntermediateRkStage;
        req.has_stage_time = true;
        req.stage_time_s = ctx.state.current_time + kDt;
        req.step_dt_s = kDt;
        std::string reason;
        check_msg(
            compute_device_demag_for_device_stage(
                ctx,
                ctx.gpu_state.device.magnetization.m,
                ctx.gpu_state.cuda.compute_stream,
                req,
                reason),
            "reset_initial_solution demag solve failed: " + reason);
        check(pred.history_count == 0u,
              "reset_initial_solution==true must invalidate predictor history");
    }

    fullmag_fem_backend_destroy(backend);
}

void test_cudss_zero_overhead_predictor()
{
    const OwnedTetMesh cube = make_kuhn_cube_mesh(2u, 2u, 2u, 20.0e-9, 20.0e-9, 20.0e-9, 99u);
    const std::vector<double> m0 = make_smooth_magnetization(cube, 20.0e-9);
    constexpr double kDt = 1.0e-13;
    const auto plan = make_base_gpu_plan(cube, m0, FULLMAG_FEM_INTEGRATOR_RK4, kDt, true, 99u);
    auto *backend = create_strict_gpu_backend(
        plan, 99u, FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_AUTO);

    if (gpu_demag_poisson_linear_solver(backend->context) ==
        GpuDemagPoissonLinearSolver::CudssDirect) {
        for (int step = 0; step < 5; ++step) {
            fullmag_fem_step_stats stats{};
            check(fullmag_fem_backend_step(backend, kDt, &stats) == FULLMAG_FEM_OK,
                  "cuDSS RK4 step must succeed");
        }
        const auto &pred = backend->context.gpu_state.device.demag_poisson.predictor;
        check(pred.d_phi_curr == nullptr &&
                  pred.d_phi_prev == nullptr &&
                  pred.capacity == 0u &&
                  pred.history_count == 0u,
              "cuDSS direct path must never allocate or touch predictor history buffers");
    }
    fullmag_fem_backend_destroy(backend);
}

void test_predictor_reduces_krylov_iterations_heun_and_rk4()
{
    const OwnedTetMesh cube = make_kuhn_cube_mesh(4u, 4u, 4u, 40.0e-9, 40.0e-9, 40.0e-9, 99u);
    const std::vector<double> m0 = make_smooth_magnetization(cube, 40.0e-9);
    constexpr double kDt = 2.0e-13;

    for (const fullmag_fem_integrator integrator : {
             FULLMAG_FEM_INTEGRATOR_HEUN,
             FULLMAG_FEM_INTEGRATOR_RK4,
         }) {
        const auto plan = make_base_gpu_plan(cube, m0, integrator, kDt, true, 99u);
        auto *with_pred = create_strict_gpu_backend(
            plan, 99u, FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_CG_AMG);
        auto *without_pred = create_strict_gpu_backend(
            plan, 99u, FULLMAG_FEM_GPU_DEMAG_SOLVER_STRATEGY_CG_AMG);

        uint64_t iters_with_pred = 0u;
        uint64_t iters_without_pred = 0u;
        for (int step = 0; step < 10; ++step) {
            // Suppress only the 2-step linear predictor on `without_pred`,
            // preserving FSAL k0 reuse and 0th-order phi_n warm-start on both.
            gpu_demag_predictor_invalidate(
                without_pred->context.gpu_state.device.demag_poisson.predictor);

            fullmag_fem_step_stats s_with{};
            fullmag_fem_step_stats s_without{};
            check(fullmag_fem_backend_step(with_pred, kDt, &s_with) == FULLMAG_FEM_OK,
                  "predictor-ON Krylov step must succeed");
            check(fullmag_fem_backend_step(without_pred, kDt, &s_without) == FULLMAG_FEM_OK,
                  "predictor-OFF Krylov step must succeed");
            check(s_with.demag_solve_count == s_without.demag_solve_count,
                  "predictor ON vs OFF must execute identical demag solve counts");
            if (step >= 2) {
                iters_with_pred += s_with.demag_linear_iterations;
                iters_without_pred += s_without.demag_linear_iterations;
            }
        }
        std::fprintf(
            stderr,
            "predictor Krylov iterations (integrator=%d, steps 3..10): with=%llu without=%llu\n",
            static_cast<int>(integrator),
            static_cast<unsigned long long>(iters_with_pred),
            static_cast<unsigned long long>(iters_without_pred));
        check(
            iters_with_pred < iters_without_pred,
            "2-step linear potential predictor must reduce total CG/AMG iterations over steps 3..10");

        const auto m_with = copy_m(with_pred, cube.node_count());
        const auto m_without = copy_m(without_pred, cube.node_count());
        check(
            max_abs_diff(m_with, m_without) <= 1.0e-10,
            "10-step predictor ON vs OFF magnetization parity must be <= 1e-10");

        fullmag_fem_backend_destroy(with_pred);
        fullmag_fem_backend_destroy(without_pred);
    }
}

#endif

} // namespace

int main()
{
    test_fsal_policy_and_signature_matrix();
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK
    int device_count = 0;
    if (cudaGetDeviceCount(&device_count) != cudaSuccess || device_count <= 0) {
        std::fprintf(
            stderr,
            "SKIP: CUDA device unavailable for executed Heun/RK4 FSAL + predictor checks\n");
        return 0;
    }
    test_predictor_kernel_math_and_equal_stage_and_guards();
    test_heun_and_rk4_fsal_demag_reduction_and_parity();
    test_drives_continuous_vs_pulse_and_invalidation();
    test_frozen_spins_and_pbc_fsal_and_endpoint_separation();
    test_transaction_rollback_during_final_field_refresh();
    test_non_rk_purpose_and_invalidate_fsal_clear_predictor();
    test_cudss_zero_overhead_predictor();
    test_predictor_reduces_krylov_iterations_heun_and_rk4();
#endif
    std::printf("FEM CUDA RK Heun/RK4 FSAL + potential predictor contract PASS\n");
    return 0;
}

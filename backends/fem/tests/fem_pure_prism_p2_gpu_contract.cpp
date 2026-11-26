/*
 * fem_pure_prism_p2_gpu_contract.cpp - End-to-end pure_prism_p2 GPU contract.
 *
 * Verifies a conforming multi-layer pure prism6 shared-domain mesh (magnetic
 * core surrounded on all 6 sides by air prism6 layers, P1 magnetization state
 * + P2 H1_WedgeElement(2) scalar potential) running on FEM GPU (both CG+AMG
 * and cuDSS when available) with exchange + Poisson-Robin demag + interfacial
 * DMI + bulk DMI against CPU MFEM parity on explicit RK4 and PGBB relaxation.
 */

#include "context.hpp"

#include <cstdio>
#include <cstdlib>

#if defined(FULLMAG_HAS_MFEM_STACK) && FULLMAG_HAS_MFEM_STACK && \
    defined(FULLMAG_HAS_CUDA_RUNTIME) && FULLMAG_HAS_CUDA_RUNTIME

#include "cpu/mfem/runtime/backend_lifecycle.hpp"
#include "cpu/mfem/runtime/backend_step.hpp"
#include "gpu/cuda/demag_poisson/poisson.hpp"
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include <sys/wait.h>
#include <unistd.h>

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

struct PurePrismMeshBuffers {
    std::vector<double> nodes_xyz;
    std::vector<uint32_t> cell_types;
    std::vector<uint32_t> cell_offsets;
    std::vector<uint32_t> cell_nodes;
    std::vector<uint64_t> cell_global_ordinals;
    std::vector<uint32_t> cell_markers;
    std::vector<uint32_t> facet_types;
    std::vector<uint32_t> facet_roles;
    std::vector<uint32_t> facet_offsets;
    std::vector<uint32_t> facet_nodes;
    std::vector<uint64_t> facet_global_ordinals;
    std::vector<uint32_t> facet_markers;

    fullmag_fem_mesh_desc desc() const
    {
        fullmag_fem_mesh_desc d{};
        d.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
        d.struct_size = sizeof(fullmag_fem_mesh_desc);
        d.nodes_xyz = nodes_xyz.data();
        d.nodes_xyz_len = static_cast<uint64_t>(nodes_xyz.size());
        d.cell_types = cell_types.data();
        d.cell_types_len = static_cast<uint64_t>(cell_types.size());
        d.cell_offsets = cell_offsets.data();
        d.cell_offsets_len = static_cast<uint64_t>(cell_offsets.size());
        d.cell_nodes = cell_nodes.data();
        d.cell_nodes_len = static_cast<uint64_t>(cell_nodes.size());
        d.cell_global_ordinals = cell_global_ordinals.data();
        d.cell_global_ordinals_len = static_cast<uint64_t>(cell_global_ordinals.size());
        d.cell_markers = cell_markers.data();
        d.cell_markers_len = static_cast<uint64_t>(cell_markers.size());
        d.facet_types = facet_types.data();
        d.facet_types_len = static_cast<uint64_t>(facet_types.size());
        d.facet_roles = facet_roles.data();
        d.facet_roles_len = static_cast<uint64_t>(facet_roles.size());
        d.facet_offsets = facet_offsets.data();
        d.facet_offsets_len = static_cast<uint64_t>(facet_offsets.size());
        d.facet_nodes = facet_nodes.data();
        d.facet_nodes_len = static_cast<uint64_t>(facet_nodes.size());
        d.facet_global_ordinals = facet_global_ordinals.data();
        d.facet_global_ordinals_len = static_cast<uint64_t>(facet_global_ordinals.size());
        d.facet_markers = facet_markers.data();
        d.facet_markers_len = static_cast<uint64_t>(facet_markers.size());
        return d;
    }
};

// Build a 100% conforming 3x3x4 extruded prism6 shared domain:
//   x in {-20, -5, +5, +20} nm, y in {-20, -5, +5, +20} nm,
//   z in {-15, -2.5, 0.0, +2.5, +15} nm.
// Inner cell (ix==1, iy==1, iz in {1, 2}) is a 2-layer 10x10x5 nm magnetic film
// (marker = 1); all surrounding layers are conforming prism6 air (marker = 0).
PurePrismMeshBuffers build_conforming_pure_prism_shared_domain()
{
    constexpr double xs[4] = {-20.0e-9, -5.0e-9, 5.0e-9, 20.0e-9};
    constexpr double ys[4] = {-20.0e-9, -5.0e-9, 5.0e-9, 20.0e-9};
    constexpr double zs[5] = {-15.0e-9, -2.5e-9, 0.0, 2.5e-9, 15.0e-9};
    constexpr uint32_t kNx = 4u;
    constexpr uint32_t kNy = 4u;
    constexpr uint32_t kNz = 5u;
    constexpr uint32_t kOuterMarker = 99u;
    constexpr uint32_t kInterfaceMarker = 10u;

    const auto nid = [&](uint32_t ix, uint32_t iy, uint32_t iz) -> uint32_t {
        return (iz * kNy + iy) * kNx + ix;
    };

    PurePrismMeshBuffers mesh{};
    mesh.nodes_xyz.reserve(static_cast<size_t>(kNx * kNy * kNz) * 3u);
    for (uint32_t iz = 0; iz < kNz; ++iz) {
        for (uint32_t iy = 0; iy < kNy; ++iy) {
            for (uint32_t ix = 0; ix < kNx; ++ix) {
                mesh.nodes_xyz.push_back(xs[ix]);
                mesh.nodes_xyz.push_back(ys[iy]);
                mesh.nodes_xyz.push_back(zs[iz]);
            }
        }
    }

    mesh.cell_offsets.push_back(0u);
    uint64_t cell_ord = 0u;
    for (uint32_t iz = 0; iz + 1u < kNz; ++iz) {
        for (uint32_t iy = 0; iy + 1u < kNy; ++iy) {
            for (uint32_t ix = 0; ix + 1u < kNx; ++ix) {
                const bool is_mag = (ix == 1u) && (iy == 1u) && (iz == 1u || iz == 2u);
                const uint32_t marker = is_mag ? 1u : 0u;
                const uint32_t b00 = nid(ix, iy, iz);
                const uint32_t b10 = nid(ix + 1u, iy, iz);
                const uint32_t b11 = nid(ix + 1u, iy + 1u, iz);
                const uint32_t b01 = nid(ix, iy + 1u, iz);
                const uint32_t t00 = nid(ix, iy, iz + 1u);
                const uint32_t t10 = nid(ix + 1u, iy, iz + 1u);
                const uint32_t t11 = nid(ix + 1u, iy + 1u, iz + 1u);
                const uint32_t t01 = nid(ix, iy + 1u, iz + 1u);

                const std::array<std::array<uint32_t, 6>, 2> prisms{{
                    {b00, b10, b11, t00, t10, t11},
                    {b00, b11, b01, t00, t11, t01},
                }};
                for (const auto &p : prisms) {
                    mesh.cell_types.push_back(FULLMAG_FEM_CELL_PRISM6);
                    mesh.cell_markers.push_back(marker);
                    mesh.cell_global_ordinals.push_back(cell_ord++);
                    mesh.cell_nodes.insert(mesh.cell_nodes.end(), p.begin(), p.end());
                    mesh.cell_offsets.push_back(static_cast<uint32_t>(mesh.cell_nodes.size()));
                }
            }
        }
    }

    mesh.facet_offsets.push_back(0u);
    uint64_t facet_ord = 0u;
    const auto add_tri = [&](uint32_t a, uint32_t b, uint32_t c, uint32_t role, uint32_t marker) {
        mesh.facet_types.push_back(FULLMAG_FEM_FACET_TRI3);
        mesh.facet_roles.push_back(role);
        mesh.facet_markers.push_back(marker);
        mesh.facet_global_ordinals.push_back(facet_ord++);
        mesh.facet_nodes.push_back(a);
        mesh.facet_nodes.push_back(b);
        mesh.facet_nodes.push_back(c);
        mesh.facet_offsets.push_back(static_cast<uint32_t>(mesh.facet_nodes.size()));
    };
    const auto add_quad =
        [&](uint32_t a, uint32_t b, uint32_t c, uint32_t d, uint32_t role, uint32_t marker) {
            mesh.facet_types.push_back(FULLMAG_FEM_FACET_QUAD4);
            mesh.facet_roles.push_back(role);
            mesh.facet_markers.push_back(marker);
            mesh.facet_global_ordinals.push_back(facet_ord++);
            mesh.facet_nodes.push_back(a);
            mesh.facet_nodes.push_back(b);
            mesh.facet_nodes.push_back(c);
            mesh.facet_nodes.push_back(d);
            mesh.facet_offsets.push_back(static_cast<uint32_t>(mesh.facet_nodes.size()));
        };

    // Exterior bottom (iz == 0) and top (iz == kNz - 1) triangular facets.
    for (uint32_t iy = 0; iy + 1u < kNy; ++iy) {
        for (uint32_t ix = 0; ix + 1u < kNx; ++ix) {
            add_tri(
                nid(ix, iy, 0u), nid(ix + 1u, iy + 1u, 0u), nid(ix + 1u, iy, 0u),
                FULLMAG_FEM_FACET_ROLE_EXTERIOR, kOuterMarker);
            add_tri(
                nid(ix, iy, 0u), nid(ix, iy + 1u, 0u), nid(ix + 1u, iy + 1u, 0u),
                FULLMAG_FEM_FACET_ROLE_EXTERIOR, kOuterMarker);
            const uint32_t top = kNz - 1u;
            add_tri(
                nid(ix, iy, top), nid(ix + 1u, iy, top), nid(ix + 1u, iy + 1u, top),
                FULLMAG_FEM_FACET_ROLE_EXTERIOR, kOuterMarker);
            add_tri(
                nid(ix, iy, top), nid(ix + 1u, iy + 1u, top), nid(ix, iy + 1u, top),
                FULLMAG_FEM_FACET_ROLE_EXTERIOR, kOuterMarker);
        }
    }
    // Exterior lateral quad facets.
    for (uint32_t iz = 0; iz + 1u < kNz; ++iz) {
        for (uint32_t ix = 0; ix + 1u < kNx; ++ix) {
            add_quad(
                nid(ix, 0u, iz), nid(ix + 1u, 0u, iz),
                nid(ix + 1u, 0u, iz + 1u), nid(ix, 0u, iz + 1u),
                FULLMAG_FEM_FACET_ROLE_EXTERIOR, kOuterMarker);
            const uint32_t ymax = kNy - 1u;
            add_quad(
                nid(ix + 1u, ymax, iz), nid(ix, ymax, iz),
                nid(ix, ymax, iz + 1u), nid(ix + 1u, ymax, iz + 1u),
                FULLMAG_FEM_FACET_ROLE_EXTERIOR, kOuterMarker);
        }
        for (uint32_t iy = 0; iy + 1u < kNy; ++iy) {
            add_quad(
                nid(0u, iy + 1u, iz), nid(0u, iy, iz),
                nid(0u, iy, iz + 1u), nid(0u, iy + 1u, iz + 1u),
                FULLMAG_FEM_FACET_ROLE_EXTERIOR, kOuterMarker);
            const uint32_t xmax = kNx - 1u;
            add_quad(
                nid(xmax, iy, iz), nid(xmax, iy + 1u, iz),
                nid(xmax, iy + 1u, iz + 1u), nid(xmax, iy, iz + 1u),
                FULLMAG_FEM_FACET_ROLE_EXTERIOR, kOuterMarker);
        }
    }
    // Magnetic/air interface facets (bottom/top tri3 + 4 lateral quad4 per layer).
    add_tri(
        nid(1u, 1u, 1u), nid(2u, 2u, 1u), nid(2u, 1u, 1u),
        FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE, kInterfaceMarker);
    add_tri(
        nid(1u, 1u, 1u), nid(1u, 2u, 1u), nid(2u, 2u, 1u),
        FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE, kInterfaceMarker);
    add_tri(
        nid(1u, 1u, 3u), nid(2u, 1u, 3u), nid(2u, 2u, 3u),
        FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE, kInterfaceMarker);
    add_tri(
        nid(1u, 1u, 3u), nid(2u, 2u, 3u), nid(1u, 2u, 3u),
        FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE, kInterfaceMarker);
    for (uint32_t iz : {1u, 2u}) {
        add_quad(
            nid(1u, 1u, iz), nid(2u, 1u, iz), nid(2u, 1u, iz + 1u), nid(1u, 1u, iz + 1u),
            FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE, kInterfaceMarker);
        add_quad(
            nid(2u, 1u, iz), nid(2u, 2u, iz), nid(2u, 2u, iz + 1u), nid(2u, 1u, iz + 1u),
            FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE, kInterfaceMarker);
        add_quad(
            nid(2u, 2u, iz), nid(1u, 2u, iz), nid(1u, 2u, iz + 1u), nid(2u, 2u, iz + 1u),
            FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE, kInterfaceMarker);
        add_quad(
            nid(1u, 2u, iz), nid(1u, 1u, iz), nid(1u, 1u, iz + 1u), nid(1u, 2u, iz + 1u),
            FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE, kInterfaceMarker);
    }
    return mesh;
}

std::vector<double> build_twisted_magnetization(const PurePrismMeshBuffers &mesh)
{
    const size_t n_nodes = mesh.nodes_xyz.size() / 3u;
    std::vector<double> m_xyz(n_nodes * 3u, 0.0);
    for (size_t i = 0; i < n_nodes; ++i) {
        const double x = mesh.nodes_xyz[i * 3u + 0u] / 20.0e-9;
        const double y = mesh.nodes_xyz[i * 3u + 1u] / 20.0e-9;
        const double z = mesh.nodes_xyz[i * 3u + 2u] / 15.0e-9;
        double mx = 0.85 + 0.12 * std::sin(1.3 * x + 0.7 * y);
        double my = 0.25 + 0.15 * std::cos(0.9 * y - 0.6 * z);
        double mz = 0.18 * std::sin(0.8 * x - 1.1 * z) + 0.05;
        const double norm = std::sqrt(mx * mx + my * my + mz * mz);
        m_xyz[i * 3u + 0u] = mx / norm;
        m_xyz[i * 3u + 1u] = my / norm;
        m_xyz[i * 3u + 2u] = mz / norm;
    }
    return m_xyz;
}

struct ScopedBackend {
    fullmag::fem::Context ctx{};
    ~ScopedBackend()
    {
        fullmag::fem::destroy_backend_runtime(ctx);
    }
};

fullmag_fem_plan_desc make_plan(
    const PurePrismMeshBuffers &mesh,
    const std::vector<double> &init_m,
    const char *device_str)
{
    fullmag_fem_plan_desc plan{};
    plan.mesh = mesh.desc();
    plan.material = {8.0e5, 1.3e-11, 0.05, 2.211e5};
    plan.fe_order = 1u;
    plan.hmax = 5.0e-9;
    plan.precision = FULLMAG_FEM_PRECISION_DOUBLE;
    plan.integrator = FULLMAG_FEM_INTEGRATOR_RK4;
    plan.dt_seconds = 2.0e-14;
    plan.enable_exchange = 1;
    plan.enable_demag = 1;
    plan.demag_realization = FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
    plan.poisson_boundary_marker = 99;
    plan.robin_beta_mode = 2;
    plan.robin_beta_factor = 2.0;
    plan.demag_solver.solver = FULLMAG_FEM_LINEAR_SOLVER_CG;
    plan.demag_solver.preconditioner = FULLMAG_FEM_PRECONDITIONER_AMG;
    plan.demag_solver.relative_tolerance = 1.0e-12;
    plan.demag_solver.has_absolute_tolerance = 1;
    plan.demag_solver.absolute_tolerance = 1.0e-20;
    plan.demag_solver.max_iterations = 500u;
    plan.has_interfacial_dmi = 1;
    plan.dmi_constant = 2.5e-3;
    plan.dmi_interface_normal[0] = 0.0;
    plan.dmi_interface_normal[1] = 0.0;
    plan.dmi_interface_normal[2] = 1.0;
    plan.has_bulk_dmi = 1;
    plan.bulk_dmi_constant = 1.2e-3;
    plan.initial_magnetization_xyz = init_m.data();
    plan.initial_magnetization_len = static_cast<uint64_t>(init_m.size());
    plan.gpu_device_index = -1;
    plan.mfem_device_string = device_str;
    plan.gpu_demag_mode = (std::string(device_str) == "cuda")
        ? FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON
        : FULLMAG_FEM_GPU_DEMAG_UNSPECIFIED;
    return plan;
}

double rel_diff(double a, double b)
{
    const double scale = std::max({std::abs(a), std::abs(b), 1.0e-30});
    return std::abs(a - b) / scale;
}

double max_magnetic_vector_diff(
    const std::vector<double> &a,
    const std::vector<double> &b,
    const std::vector<uint8_t> &mag_mask)
{
    check(a.size() == b.size() && a.size() == mag_mask.size() * 3u,
          "magnetization vector length mismatch");
    double max_err = 0.0;
    for (size_t i = 0; i < mag_mask.size(); ++i) {
        if (mag_mask[i] == 0u) {
            continue;
        }
        for (size_t c = 0; c < 3u; ++c) {
            max_err = std::max(max_err, std::abs(a[i * 3u + c] - b[i * 3u + c]));
        }
    }
    return max_err;
}

constexpr int kPgbbSteps = 3;

struct CpuReferenceHeader {
    double rk_exchange_energy_joules;
    double rk_demag_energy_joules;
    double rk_dmi_energy_joules;
    double rk_total_energy_joules;
    double pgbb_total_energy_joules[kPgbbSteps];
    double pgbb_dmi_energy_joules[kPgbbSteps];
    double pgbb_demag_energy_joules[kPgbbSteps];
    uint64_t m_len;
    uint64_t mag_mask_len;
};

struct CpuReferenceData {
    CpuReferenceHeader header{};
    std::vector<double> rk_m_xyz;
    std::vector<uint8_t> mag_mask;
};

bool write_all(int fd, const void *buf, size_t nbytes)
{
    const auto *ptr = static_cast<const uint8_t *>(buf);
    size_t written = 0u;
    while (written < nbytes) {
        const ssize_t rc = write(fd, ptr + written, nbytes - written);
        if (rc < 0) {
            if (errno == EINTR) {
                continue;
            }
            return false;
        }
        if (rc == 0) {
            return false;
        }
        written += static_cast<size_t>(rc);
    }
    return true;
}

bool read_all(int fd, void *buf, size_t nbytes)
{
    auto *ptr = static_cast<uint8_t *>(buf);
    size_t got = 0u;
    while (got < nbytes) {
        const ssize_t rc = read(fd, ptr + got, nbytes - got);
        if (rc < 0) {
            if (errno == EINTR) {
                continue;
            }
            return false;
        }
        if (rc == 0) {
            return false;
        }
        got += static_cast<size_t>(rc);
    }
    return true;
}

CpuReferenceData compute_cpu_reference(
    const PurePrismMeshBuffers &mesh,
    const std::vector<double> &init_m)
{
    const uint32_t boundary_marker = 99u;
    const fullmag_fem_plan_desc cpu_plan = make_plan(mesh, init_m, "cpu");
    std::string error;

    CpuReferenceData ref{};
    {
        ScopedBackend cpu_rk{};
        check(fullmag::fem::initialize_backend_runtime(
                  cpu_rk.ctx, cpu_plan, error, nullptr, &boundary_marker),
              error.c_str());
        check(cpu_rk.ctx.poisson_demag.potential_order == 2,
              "CPU pure_prism_p2 must resolve P2 scalar potential");
        fullmag_fem_step_stats cpu_stats{};
        error.clear();
        check(fullmag::fem::run_backend_step(
                  cpu_rk.ctx, cpu_plan.dt_seconds, cpu_stats, error) == FULLMAG_FEM_OK,
              error.c_str());
        ref.header.rk_exchange_energy_joules = cpu_stats.exchange_energy_joules;
        ref.header.rk_demag_energy_joules = cpu_stats.demag_energy_joules;
        ref.header.rk_dmi_energy_joules = cpu_stats.dmi_energy_joules;
        ref.header.rk_total_energy_joules = cpu_stats.total_energy_joules;
        ref.rk_m_xyz = cpu_rk.ctx.state.m_xyz;
        ref.mag_mask = cpu_rk.ctx.mesh.magnetic_node_mask;
        ref.header.m_len = static_cast<uint64_t>(ref.rk_m_xyz.size());
        ref.header.mag_mask_len = static_cast<uint64_t>(ref.mag_mask.size());
    }

    {
        ScopedBackend cpu_pgbb{};
        error.clear();
        check(fullmag::fem::initialize_backend_runtime(
                  cpu_pgbb.ctx, cpu_plan, error, nullptr, &boundary_marker),
              error.c_str());
        for (int step = 0; step < kPgbbSteps; ++step) {
            fullmag_fem_step_stats c_rel{};
            error.clear();
            check(fullmag::fem::run_backend_relaxation_step(
                      cpu_pgbb.ctx, FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB, c_rel, error) ==
                      FULLMAG_FEM_OK,
                  error.c_str());
            ref.header.pgbb_total_energy_joules[step] = c_rel.total_energy_joules;
            ref.header.pgbb_dmi_energy_joules[step] = c_rel.dmi_energy_joules;
            ref.header.pgbb_demag_energy_joules[step] = c_rel.demag_energy_joules;
        }
    }

    return ref;
}

// Public MFEM/HYPRE backend creation binds process-wide mfem::Device and
// HYPRE_SetMemoryLocation (HOST vs DEVICE). Run the CPU MFEM reference in a
// clean forked child BEFORE the parent initializes CUDA/MFEM/HYPRE.
CpuReferenceData run_cpu_reference_in_subprocess(
    const PurePrismMeshBuffers &mesh,
    const std::vector<double> &init_m)
{
    std::fflush(nullptr);
    int pipe_fds[2] = {-1, -1};
    check(pipe(pipe_fds) == 0, "pipe() failed for CPU reference subprocess");
    const pid_t child = fork();
    check(child >= 0, "fork() failed for CPU reference subprocess");
    if (child == 0) {
        close(pipe_fds[0]);
        const CpuReferenceData ref = compute_cpu_reference(mesh, init_m);
        const bool ok =
            write_all(pipe_fds[1], &ref.header, sizeof(ref.header)) &&
            write_all(
                pipe_fds[1],
                ref.rk_m_xyz.data(),
                static_cast<size_t>(ref.header.m_len) * sizeof(double)) &&
            write_all(
                pipe_fds[1],
                ref.mag_mask.data(),
                static_cast<size_t>(ref.header.mag_mask_len) * sizeof(uint8_t));
        close(pipe_fds[1]);
        std::fflush(nullptr);
        _exit(ok ? 0 : 2);
    }

    close(pipe_fds[1]);
    CpuReferenceData ref{};
    const bool hdr_ok = read_all(pipe_fds[0], &ref.header, sizeof(ref.header));
    bool payload_ok = false;
    if (hdr_ok) {
        ref.rk_m_xyz.resize(static_cast<size_t>(ref.header.m_len));
        ref.mag_mask.resize(static_cast<size_t>(ref.header.mag_mask_len));
        payload_ok =
            read_all(
                pipe_fds[0],
                ref.rk_m_xyz.data(),
                static_cast<size_t>(ref.header.m_len) * sizeof(double)) &&
            read_all(
                pipe_fds[0],
                ref.mag_mask.data(),
                static_cast<size_t>(ref.header.mag_mask_len) * sizeof(uint8_t));
    }
    close(pipe_fds[0]);

    int status = 0;
    pid_t waited = -1;
    do {
        waited = waitpid(child, &status, 0);
    } while (waited < 0 && errno == EINTR);
    check(waited == child && WIFEXITED(status) && WEXITSTATUS(status) == 0,
          "CPU reference subprocess failed");
    check(hdr_ok && payload_ok, "failed to receive CPU reference payload from subprocess");
    return ref;
}

void run_gpu_parity_for_strategy(
    const PurePrismMeshBuffers &mesh,
    const std::vector<double> &init_m,
    const CpuReferenceData &cpu_ref,
    fullmag::fem::GpuDemagSolverStrategy strategy,
    const char *label)
{
    const uint32_t boundary_marker = 99u;
    ScopedBackend gpu_rk{};
    gpu_rk.ctx.poisson_demag.gpu_solver_strategy = strategy;

    const fullmag_fem_plan_desc gpu_plan = make_plan(mesh, init_m, "cuda");
    std::string error;
    if (!fullmag::fem::initialize_backend_runtime(
            gpu_rk.ctx, gpu_plan, error, nullptr, &boundary_marker)) {
        if (strategy == fullmag::fem::GpuDemagSolverStrategy::Cudss &&
            error.find("cuDSS") != std::string::npos) {
            std::fprintf(stderr, "SKIP %s: %s\n", label, error.c_str());
            return;
        }
        check(false, error.c_str());
    }

    // Verify pure_prism_p2 GPU invariants: P2 scalar potential, no tet4 mesh_geometry, CSR DMI ready.
    check(gpu_rk.ctx.poisson_demag.potential_order == 2,
          "GPU pure_prism_p2 must resolve P2 scalar potential");
    check(gpu_rk.ctx.gpu_state.device.demag_poisson.scalar_dof_count > gpu_rk.ctx.mesh.n_nodes,
          "GPU pure_prism_p2 scalar potential DOF count must exceed P1 node count");
    check(!gpu_rk.ctx.gpu_state.device.mesh_geometry.uploaded,
          "GPU pure_prism_p2 with CSR DMI must not upload flat tetrahedral mesh_geometry");
    check(gpu_rk.ctx.gpu_state.device.dmi_csr.interfacial.uploaded &&
              gpu_rk.ctx.gpu_state.device.dmi_csr.bulk.uploaded,
          "GPU pure_prism_p2 must upload both interfacial and bulk CSR DMI channels");
    if (strategy == fullmag::fem::GpuDemagSolverStrategy::Cudss) {
        check(fullmag::fem::gpu_demag_poisson_linear_solver(gpu_rk.ctx) ==
                  fullmag::fem::GpuDemagPoissonLinearSolver::CudssDirect,
              "forced cuDSS strategy on pure_prism_p2 must resolve CudssDirect");
    } else if (strategy == fullmag::fem::GpuDemagSolverStrategy::CgAmg) {
        check(fullmag::fem::gpu_demag_poisson_linear_solver(gpu_rk.ctx) ==
                  fullmag::fem::GpuDemagPoissonLinearSolver::HypreKrylov,
              "CG+AMG strategy on pure_prism_p2 must resolve HypreKrylov");
    }

    // 1. Explicit RK4 step parity vs CPU MFEM reference.
    fullmag_fem_step_stats gpu_stats{};
    error.clear();
    check(fullmag::fem::run_backend_step(
              gpu_rk.ctx, gpu_plan.dt_seconds, gpu_stats, error) == FULLMAG_FEM_OK,
          error.c_str());

    std::vector<double> gpu_m_after_rk;
    error.clear();
    check(fullmag::fem::gpu_state_download_magnetization_aos(
              gpu_rk.ctx.gpu_state.device,
              gpu_m_after_rk,
              gpu_rk.ctx.transfer_audit.audit,
              error),
          error.c_str());

    check(rel_diff(gpu_stats.exchange_energy_joules, cpu_ref.header.rk_exchange_energy_joules) <= 1.0e-10,
          "pure_prism_p2 RK4 exchange energy GPU vs CPU parity failed");
    check(rel_diff(gpu_stats.demag_energy_joules, cpu_ref.header.rk_demag_energy_joules) <= 1.0e-10,
          "pure_prism_p2 RK4 P2 demag energy GPU vs CPU parity failed");
    check(rel_diff(gpu_stats.dmi_energy_joules, cpu_ref.header.rk_dmi_energy_joules) <= 1.0e-10,
          "pure_prism_p2 RK4 CSR DMI energy GPU vs CPU parity failed");
    check(rel_diff(gpu_stats.total_energy_joules, cpu_ref.header.rk_total_energy_joules) <= 1.0e-10,
          "pure_prism_p2 RK4 total energy GPU vs CPU parity failed");
    check(max_magnetic_vector_diff(
              gpu_m_after_rk, cpu_ref.rk_m_xyz, cpu_ref.mag_mask) <= 1.0e-10,
          "pure_prism_p2 RK4 magnetization GPU vs CPU parity failed");

    // 2. Direct minimizer PGBB step parity (exercises CSR DMI double-double Armijo energy increment).
    ScopedBackend gpu_pgbb{};
    gpu_pgbb.ctx.poisson_demag.gpu_solver_strategy = strategy;
    error.clear();
    check(fullmag::fem::initialize_backend_runtime(
              gpu_pgbb.ctx, gpu_plan, error, nullptr, &boundary_marker),
          error.c_str());

    for (int step = 0; step < kPgbbSteps; ++step) {
        fullmag_fem_step_stats g_rel{};
        error.clear();
        check(fullmag::fem::run_backend_relaxation_step(
                  gpu_pgbb.ctx, FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB, g_rel, error) ==
                  FULLMAG_FEM_OK,
              error.c_str());
        check(std::isfinite(g_rel.total_energy_joules) &&
                  rel_diff(g_rel.total_energy_joules, cpu_ref.header.pgbb_total_energy_joules[step]) <= 1.0e-9,
              "pure_prism_p2 PGBB total energy GPU vs CPU parity failed");
        check(rel_diff(g_rel.dmi_energy_joules, cpu_ref.header.pgbb_dmi_energy_joules[step]) <= 1.0e-9,
              "pure_prism_p2 PGBB DMI energy GPU vs CPU parity failed");
        check(rel_diff(g_rel.demag_energy_joules, cpu_ref.header.pgbb_demag_energy_joules[step]) <= 1.0e-9,
              "pure_prism_p2 PGBB P2 demag energy GPU vs CPU parity failed");
    }

    std::printf(
        "PASS %s: P2_DOFs=%llu, E_demag=%.6e J, E_dmi=%.6e J\n",
        label,
        static_cast<unsigned long long>(gpu_rk.ctx.gpu_state.device.demag_poisson.scalar_dof_count),
        gpu_stats.demag_energy_joules,
        gpu_stats.dmi_energy_joules);
}

} // namespace

int main()
{
    const PurePrismMeshBuffers mesh = build_conforming_pure_prism_shared_domain();
    const std::vector<double> init_m = build_twisted_magnetization(mesh);

    // Fork and run the CPU MFEM reference BEFORE calling any CUDA/MFEM/HYPRE API
    // in the parent process so mfem::Device / HYPRE_SetMemoryLocation stay isolated.
    const CpuReferenceData cpu_ref = run_cpu_reference_in_subprocess(mesh, init_m);

    int device_count = 0;
    const cudaError_t rc = cudaGetDeviceCount(&device_count);
    if (rc != cudaSuccess || device_count <= 0) {
        std::fprintf(stderr, "SKIP fem_pure_prism_p2_gpu_contract: no visible CUDA device\n");
        return 0;
    }

    run_gpu_parity_for_strategy(
        mesh, init_m, cpu_ref, fullmag::fem::GpuDemagSolverStrategy::CgAmg, "pure_prism_p2_gpu_cg_amg");
    run_gpu_parity_for_strategy(
        mesh, init_m, cpu_ref, fullmag::fem::GpuDemagSolverStrategy::Cudss, "pure_prism_p2_gpu_cudss");
    return 0;
}

#else

int main()
{
    std::fprintf(stderr, "SKIP fem_pure_prism_p2_gpu_contract: built without MFEM+CUDA\n");
    return 0;
}

#endif

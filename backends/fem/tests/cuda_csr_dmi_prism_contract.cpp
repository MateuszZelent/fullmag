/*
 * cuda_csr_dmi_prism_contract.cpp - CUDA parity and invariant tests for the
 * unified preassembled skew-symmetric CSR GPU DMI operator across tet4,
 * multi-layer prism6, conforming mixed prism6+pyramid5+tet4, and 2D periodic
 * tet4 meshes.
 */

#include "context.hpp"

#include <cstdio>
#include <cstdlib>

#if defined(FULLMAG_HAS_MFEM_STACK) && FULLMAG_HAS_MFEM_STACK && \
    defined(FULLMAG_HAS_CUDA_RUNTIME) && FULLMAG_HAS_CUDA_RUNTIME

#include "core/fem_material_runtime.hpp"
#include "cpu/mfem/interactions/dmi_bulk.hpp"
#include "cpu/mfem/interactions/dmi_interfacial.hpp"
#include "cpu/mfem/runtime/mfem_context.hpp"
#include "gpu/cuda/integrators/rk/rk_dmi_energy_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk_dmi_fields.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/interactions/dmi/dmi_csr_kernels.hpp"
#include "gpu/cuda/interactions/dmi/dmi_csr_operator.hpp"
#include "gpu/cuda/reductions/reduction_kernels.hpp"
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>
#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace {

using fullmag::fem::Context;
using fullmag::fem::FemMeshRuntimeState;
using fullmag::fem::GpuDmiCsrHostData;
using fullmag::fem::GpuFinalScalarSlot;

void check(bool condition, const char *msg)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

void check_cuda(cudaError_t rc, const char *msg)
{
    if (rc != cudaSuccess) {
        std::fprintf(stderr, "FAIL: %s (%s)\n", msg, cudaGetErrorString(rc));
        std::exit(1);
    }
}

struct ScopedFemContext {
    Context ctx{};
    ~ScopedFemContext()
    {
        fullmag::fem::gpu_state_destroy(ctx.gpu_state.device);
        fullmag::fem::context_destroy_mfem(ctx);
    }
};

struct MeshFixture {
    const char *name = "";
    FemMeshRuntimeState mesh{};
};

void populate_magnetic_masks(FemMeshRuntimeState &mesh)
{
    mesh.magnetic_element_mask.assign(mesh.n_elements, 0u);
    mesh.magnetic_node_mask.assign(mesh.n_nodes, 0u);
    for (uint32_t e = 0; e < mesh.n_elements; ++e) {
        const bool is_mag = mesh.cell_markers[e] != 0u;
        mesh.magnetic_element_mask[e] = is_mag ? 1u : 0u;
        if (is_mag) {
            for (uint32_t p = mesh.cell_offsets[e]; p < mesh.cell_offsets[e + 1u]; ++p) {
                mesh.magnetic_node_mask[mesh.cell_nodes[p]] = 1u;
            }
        }
    }
}

MeshFixture make_tet4_box_mesh(
    int nx,
    int ny,
    int nz,
    double lx,
    double ly,
    double lz,
    bool periodic_xy)
{
    MeshFixture fixture{};
    fixture.name = periodic_xy ? "tet4_periodic_2d" : "tet4";
    auto &mesh = fixture.mesh;
    const auto vid = [nx, ny](int ix, int iy, int iz) -> uint32_t {
        return static_cast<uint32_t>((iz * (ny + 1) + iy) * (nx + 1) + ix);
    };
    const int n_nodes = (nx + 1) * (ny + 1) * (nz + 1);
    mesh.n_nodes = static_cast<uint32_t>(n_nodes);
    mesh.nodes_xyz.resize(static_cast<size_t>(n_nodes) * 3u);
    for (int iz = 0; iz <= nz; ++iz) {
        for (int iy = 0; iy <= ny; ++iy) {
            for (int ix = 0; ix <= nx; ++ix) {
                const size_t base = static_cast<size_t>(vid(ix, iy, iz)) * 3u;
                mesh.nodes_xyz[base + 0u] = lx * static_cast<double>(ix) / static_cast<double>(nx);
                mesh.nodes_xyz[base + 1u] = ly * static_cast<double>(iy) / static_cast<double>(ny);
                mesh.nodes_xyz[base + 2u] = lz * static_cast<double>(iz) / static_cast<double>(nz);
            }
        }
    }

    mesh.cell_offsets.push_back(0u);
    for (int iz = 0; iz < nz; ++iz) {
        for (int iy = 0; iy < ny; ++iy) {
            for (int ix = 0; ix < nx; ++ix) {
                const uint32_t v000 = vid(ix, iy, iz);
                const uint32_t v100 = vid(ix + 1, iy, iz);
                const uint32_t v010 = vid(ix, iy + 1, iz);
                const uint32_t v110 = vid(ix + 1, iy + 1, iz);
                const uint32_t v001 = vid(ix, iy, iz + 1);
                const uint32_t v101 = vid(ix + 1, iy, iz + 1);
                const uint32_t v011 = vid(ix, iy + 1, iz + 1);
                const uint32_t v111 = vid(ix + 1, iy + 1, iz + 1);
                // Six positive-volume Kuhn tetrahedra with matching opposite-face diagonals.
                const std::array<std::array<uint32_t, 4>, 6> tets = {{
                    {v000, v100, v110, v111},
                    {v000, v110, v010, v111},
                    {v000, v010, v011, v111},
                    {v000, v011, v001, v111},
                    {v000, v001, v101, v111},
                    {v000, v101, v100, v111},
                }};
                for (const auto &tet : tets) {
                    mesh.cell_types.push_back(FULLMAG_FEM_CELL_TET4);
                    mesh.cell_markers.push_back(1u);
                    for (uint32_t node : tet) {
                        mesh.cell_nodes.push_back(node);
                    }
                    mesh.cell_offsets.push_back(static_cast<uint32_t>(mesh.cell_nodes.size()));
                }
            }
        }
    }
    mesh.n_elements = static_cast<uint32_t>(mesh.cell_types.size());
    populate_magnetic_masks(mesh);

    if (periodic_xy) {
        const auto cid = [nx, ny](int ix, int iy, int iz) -> uint32_t {
            const int rx = ix % nx;
            const int ry = iy % ny;
            return static_cast<uint32_t>((iz * ny + ry) * nx + rx);
        };
        const uint32_t reduced_count = static_cast<uint32_t>(nx * ny * (nz + 1));
        mesh.periodic_reduced_node.resize(mesh.n_nodes);
        mesh.periodic_representative_nodes.assign(reduced_count, 0u);
        mesh.periodic_reduced_node_count = reduced_count;
        mesh.periodic_map_revision = 1u;
        for (int iz = 0; iz <= nz; ++iz) {
            for (int iy = 0; iy <= ny; ++iy) {
                for (int ix = 0; ix <= nx; ++ix) {
                    const uint32_t node = vid(ix, iy, iz);
                    const uint32_t reduced = cid(ix, iy, iz);
                    mesh.periodic_reduced_node[node] = reduced;
                    if (ix < nx && iy < ny) {
                        mesh.periodic_representative_nodes[reduced] = node;
                    }
                }
            }
        }
    }
    return fixture;
}

MeshFixture make_multilayer_prism6_mesh(
    int nx,
    int ny,
    int nz,
    double lx,
    double ly,
    double lz)
{
    MeshFixture fixture{};
    fixture.name = "prism6_multilayer";
    auto &mesh = fixture.mesh;
    const auto vid = [nx, ny](int ix, int iy, int iz) -> uint32_t {
        return static_cast<uint32_t>((iz * (ny + 1) + iy) * (nx + 1) + ix);
    };
    const int n_nodes = (nx + 1) * (ny + 1) * (nz + 1);
    mesh.n_nodes = static_cast<uint32_t>(n_nodes);
    mesh.nodes_xyz.resize(static_cast<size_t>(n_nodes) * 3u);
    for (int iz = 0; iz <= nz; ++iz) {
        for (int iy = 0; iy <= ny; ++iy) {
            for (int ix = 0; ix <= nx; ++ix) {
                const size_t base = static_cast<size_t>(vid(ix, iy, iz)) * 3u;
                mesh.nodes_xyz[base + 0u] = lx * static_cast<double>(ix) / static_cast<double>(nx);
                mesh.nodes_xyz[base + 1u] = ly * static_cast<double>(iy) / static_cast<double>(ny);
                mesh.nodes_xyz[base + 2u] = lz * static_cast<double>(iz) / static_cast<double>(nz);
            }
        }
    }

    mesh.cell_offsets.push_back(0u);
    for (int iz = 0; iz < nz; ++iz) {
        for (int iy = 0; iy < ny; ++iy) {
            for (int ix = 0; ix < nx; ++ix) {
                const uint32_t v000 = vid(ix, iy, iz);
                const uint32_t v100 = vid(ix + 1, iy, iz);
                const uint32_t v010 = vid(ix, iy + 1, iz);
                const uint32_t v110 = vid(ix + 1, iy + 1, iz);
                const uint32_t v001 = vid(ix, iy, iz + 1);
                const uint32_t v101 = vid(ix + 1, iy, iz + 1);
                const uint32_t v011 = vid(ix, iy + 1, iz + 1);
                const uint32_t v111 = vid(ix + 1, iy + 1, iz + 1);
                const std::array<std::array<uint32_t, 6>, 2> prisms = {{
                    {v000, v100, v110, v001, v101, v111},
                    {v000, v110, v010, v001, v111, v011},
                }};
                for (const auto &prism : prisms) {
                    mesh.cell_types.push_back(FULLMAG_FEM_CELL_PRISM6);
                    mesh.cell_markers.push_back(1u);
                    for (uint32_t node : prism) {
                        mesh.cell_nodes.push_back(node);
                    }
                    mesh.cell_offsets.push_back(static_cast<uint32_t>(mesh.cell_nodes.size()));
                }
            }
        }
    }
    mesh.n_elements = static_cast<uint32_t>(mesh.cell_types.size());
    populate_magnetic_masks(mesh);
    return fixture;
}

MeshFixture make_mixed_prism_pyramid_tet_mesh()
{
    MeshFixture fixture{};
    fixture.name = "mixed_prism6_pyramid5_tet4";
    auto &mesh = fixture.mesh;
    constexpr double s = 5.0e-9;
    // Conforming stack: 2 magnetic prism6 layers + 1 magnetic pyramid5 + 1 magnetic tet4 + 1 air tet4.
    const std::vector<double> raw_nodes = {
        0.0,  0.0, 0.0, // 0
        1.0,  0.0, 0.0, // 1
        0.0,  1.0, 0.0, // 2
        0.0,  0.0, 1.0, // 3
        1.0,  0.0, 1.0, // 4
        0.0,  1.0, 1.0, // 5
        0.5, -1.0, 0.5, // 6 (pyramid apex)
        1.5, -1.0, 0.5, // 7 (magnetic tet4 vertex)
        0.0,  0.0, 2.0, // 8 (top prism6 layer)
        1.0,  0.0, 2.0, // 9
        0.0,  1.0, 2.0, // 10
        1.0, -2.0, 0.5, // 11 (air-only tet4 vertex)
    };
    mesh.n_nodes = static_cast<uint32_t>(raw_nodes.size() / 3u);
    mesh.nodes_xyz.resize(raw_nodes.size());
    for (size_t i = 0; i < raw_nodes.size(); ++i) {
        mesh.nodes_xyz[i] = raw_nodes[i] * s;
    }
    mesh.cell_types = {
        FULLMAG_FEM_CELL_PRISM6,
        FULLMAG_FEM_CELL_PRISM6,
        FULLMAG_FEM_CELL_PYRAMID5,
        FULLMAG_FEM_CELL_TET4,
        FULLMAG_FEM_CELL_TET4,
    };
    mesh.cell_offsets = {0u, 6u, 12u, 17u, 21u, 25u};
    mesh.cell_nodes = {
        0u, 1u, 2u, 3u, 4u, 5u,
        3u, 4u, 5u, 8u, 9u, 10u,
        0u, 1u, 4u, 3u, 6u,
        1u, 4u, 6u, 7u,
        4u, 6u, 7u, 11u,
    };
    mesh.cell_markers = {1u, 1u, 1u, 1u, 0u};
    mesh.n_elements = static_cast<uint32_t>(mesh.cell_types.size());
    populate_magnetic_masks(mesh);
    return fixture;
}

std::vector<double> make_twisted_magnetization(
    const FemMeshRuntimeState &mesh,
    bool periodic_xy,
    double lx,
    double ly,
    double phase_shift = 0.0)
{
    constexpr double kTwoPi = 6.283185307179586476925286766559;
    std::vector<double> m(static_cast<size_t>(mesh.n_nodes) * 3u, 0.0);
    for (uint32_t node = 0; node < mesh.n_nodes; ++node) {
        const size_t base = static_cast<size_t>(node) * 3u;
        const double x = mesh.nodes_xyz[base + 0u];
        const double y = mesh.nodes_xyz[base + 1u];
        const double z = mesh.nodes_xyz[base + 2u];
        double mx = 0.0;
        double my = 0.0;
        double mz = 0.0;
        if (periodic_xy) {
            const double kx = kTwoPi * x / lx + phase_shift;
            const double ky = kTwoPi * y / ly - 0.5 * phase_shift;
            const double kz = 0.35e9 * z;
            mx = 0.65 * std::cos(kx) + 0.25 * std::sin(ky + kz);
            my = 0.60 * std::sin(kx - ky) + 0.20 * std::cos(kz);
            mz = 0.70 + 0.25 * std::cos(kx + ky) - 0.15 * std::sin(ky - kz);
        } else {
            const double sx = 1.7e8 * x + 0.35 + phase_shift;
            const double sy = 2.1e8 * y - 0.25 - 0.7 * phase_shift;
            const double sz = 3.3e8 * z + 0.15;
            mx = std::sin(sx + 0.6 * sy) * std::cos(sz) + 0.22 * sy;
            my = std::cos(0.8 * sx - sy) + 0.31 * std::sin(sz + sx);
            mz = 0.55 + 0.45 * std::cos(sx + sy + sz) - 0.18 * sx;
        }
        const double norm = std::sqrt(mx * mx + my * my + mz * mz);
        m[base + 0u] = mx / norm;
        m[base + 1u] = my / norm;
        m[base + 2u] = mz / norm;
    }
    if (!mesh.periodic_reduced_node.empty()) {
        for (uint32_t node = 0; node < mesh.n_nodes; ++node) {
            const uint32_t rep =
                mesh.periodic_representative_nodes[mesh.periodic_reduced_node[node]];
            const size_t dst = static_cast<size_t>(node) * 3u;
            const size_t src = static_cast<size_t>(rep) * 3u;
            m[dst + 0u] = m[src + 0u];
            m[dst + 1u] = m[src + 1u];
            m[dst + 2u] = m[src + 2u];
        }
    }
    return m;
}

std::vector<double> make_spatial_d_field(
    const FemMeshRuntimeState &mesh,
    double d_base,
    double d_amp)
{
    std::vector<double> field(mesh.n_nodes, d_base);
    for (uint32_t node = 0; node < mesh.n_nodes; ++node) {
        const size_t base = static_cast<size_t>(node) * 3u;
        const double x = mesh.nodes_xyz[base + 0u];
        const double y = mesh.nodes_xyz[base + 1u];
        const double z = mesh.nodes_xyz[base + 2u];
        field[node] = d_base + d_amp * (0.4 * std::sin(1.4e8 * x) + 0.6 * std::cos(1.9e8 * y + 2.5e8 * z));
    }
    return field;
}

struct DmiCaseConfig {
    const char *label = "";
    bool interfacial_enabled = false;
    double interfacial_D = 0.0;
    std::array<double, 3> interface_normal = {0.0, 0.0, 1.0};
    bool use_dind_field = false;
    bool rotated_interfacial_enabled = false;
    double rotated_interfacial_D = 0.0;
    bool bulk_enabled = false;
    double bulk_D = 0.0;
    bool use_dbulk_field = false;
    bool expect_zero = false;
};

void initialize_context_for_gpu_dmi(
    ScopedFemContext &holder,
    const FemMeshRuntimeState &mesh,
    const std::vector<double> &m_xyz,
    const DmiCaseConfig &cfg)
{
    Context &ctx = holder.ctx;
    ctx.mesh = mesh;
    ctx.base_plan.fe_order = 1u;
    ctx.base_plan.integrator = FULLMAG_FEM_INTEGRATOR_HEUN;
    ctx.exchange.enabled = true;
    ctx.material_fields.material.saturation_magnetisation = 8.0e5;
    ctx.material_fields.material.exchange_stiffness = 13.0e-12;
    ctx.material_fields.material.damping = 0.02;
    ctx.material_fields.material.gyromagnetic_ratio = 2.211e5;
    ctx.state.m_xyz = m_xyz;
    ctx.mfem_device.device_string_override = "cpu";

    ctx.dmi.interfacial_enabled = cfg.interfacial_enabled;
    ctx.dmi.interfacial_D = cfg.interfacial_D;
    ctx.dmi.interface_normal = cfg.interface_normal;
    ctx.dmi.rotated_interfacial_enabled = cfg.rotated_interfacial_enabled;
    ctx.dmi.rotated_interfacial_D = cfg.rotated_interfacial_D;
    ctx.dmi.bulk_enabled = cfg.bulk_enabled;
    ctx.dmi.bulk_D = cfg.bulk_D;

    if (cfg.use_dind_field) {
        ctx.material_fields.Dind_field = make_spatial_d_field(mesh, 1.8e-3, 0.7e-3);
    }
    if (cfg.use_dbulk_field) {
        ctx.material_fields.Dbulk_field = make_spatial_d_field(mesh, 2.0e-3, 0.6e-3);
    }

    std::string error;
    check(fullmag::fem::initialize_material_runtime(ctx, error), error.c_str());
    check(fullmag::fem::context_initialize_mfem(ctx, error), error.c_str());

    check(
        fullmag::fem::gpu_state_initialize(
            ctx.gpu_state.device,
            ctx.mesh.n_nodes,
            FULLMAG_FEM_INTEGRATOR_HEUN,
            true,
            false,
            m_xyz.data(),
            static_cast<uint64_t>(m_xyz.size()),
            ctx.transfer_audit.audit,
            error),
        error.c_str());

    check(
        fullmag::fem::gpu_state_upload_runtime_coefficients(
            ctx.gpu_state.device,
            ctx.integration_weights.mfem_lumped_mass.data(),
            static_cast<uint64_t>(ctx.integration_weights.mfem_lumped_mass.size()),
            nullptr, 0u, ctx.material_fields.material.saturation_magnetisation,
            nullptr, 0u, ctx.material_fields.material.exchange_stiffness,
            nullptr, 0u, ctx.material_fields.material.damping,
            nullptr, 0u,
            nullptr, 0u,
            nullptr, 0u, 0.0,
            nullptr, 0u, 0.0,
            nullptr, 0u, 1.0,
            ctx.material_fields.Dind_field.empty() ? nullptr : ctx.material_fields.Dind_field.data(),
            static_cast<uint64_t>(ctx.material_fields.Dind_field.size()),
            ctx.material_fields.Dbulk_field.empty() ? nullptr : ctx.material_fields.Dbulk_field.data(),
            static_cast<uint64_t>(ctx.material_fields.Dbulk_field.size()),
            nullptr, 0u,
            nullptr, 0u,
            nullptr, 0u,
            ctx.mesh.magnetic_node_mask.empty() ? nullptr : ctx.mesh.magnetic_node_mask.data(),
            static_cast<uint64_t>(ctx.mesh.magnetic_node_mask.size()),
            ctx.mesh.periodic_reduced_node.empty() ? nullptr : ctx.mesh.periodic_reduced_node.data(),
            static_cast<uint64_t>(ctx.mesh.periodic_reduced_node.size()),
            ctx.mesh.periodic_representative_nodes.empty() ? nullptr : ctx.mesh.periodic_representative_nodes.data(),
            static_cast<uint64_t>(ctx.mesh.periodic_representative_nodes.size()),
            ctx.transfer_audit.audit,
            error),
        error.c_str());

    check(fullmag::fem::context_upload_mfem_exchange_to_gpu_state(ctx, error), error.c_str());
    check(fullmag::fem::context_upload_mfem_dmi_to_gpu_state(ctx, error), error.c_str());
    check(
        !ctx.gpu_state.device.mesh_geometry.uploaded,
        "CSR DMI GPU upload must not require flat tetrahedral mesh_geometry");
}

double max_abs(const std::vector<double> &v)
{
    double m = 0.0;
    for (double x : v) {
        m = std::max(m, std::abs(x));
    }
    return m;
}

double max_abs_diff(const std::vector<double> &a, const std::vector<double> &b)
{
    check(a.size() == b.size(), "vector size mismatch in max_abs_diff");
    double d = 0.0;
    for (size_t i = 0; i < a.size(); ++i) {
        d = std::max(d, std::abs(a[i] - b[i]));
    }
    return d;
}

double host_polarized_csr_dmi_difference(
    const GpuDmiCsrHostData &csr,
    const std::vector<double> &m0,
    const std::vector<double> &m1,
    const std::vector<uint32_t> *periodic_reps)
{
    const auto &offsets = periodic_reps != nullptr
        ? csr.periodic_reduced_row_offsets
        : csr.row_offsets;
    const auto &cols = periodic_reps != nullptr
        ? csr.periodic_reduced_col_indices
        : csr.col_indices;
    const auto &dx = periodic_reps != nullptr ? csr.periodic_reduced_dx : csr.dx;
    const auto &dy = periodic_reps != nullptr ? csr.periodic_reduced_dy : csr.dy;
    const auto &dz = periodic_reps != nullptr ? csr.periodic_reduced_dz : csr.dz;
    const uint32_t rows = periodic_reps != nullptr ? csr.periodic_reduced_rows : csr.rows;

    long double acc = 0.0L;
    for (uint32_t r = 0; r < rows; ++r) {
        const uint32_t i = periodic_reps != nullptr ? (*periodic_reps)[r] : r;
        const size_t ib = static_cast<size_t>(i) * 3u;
        const long double sx = static_cast<long double>(m1[ib + 0u]) + static_cast<long double>(m0[ib + 0u]);
        const long double sy = static_cast<long double>(m1[ib + 1u]) + static_cast<long double>(m0[ib + 1u]);
        const long double sz = static_cast<long double>(m1[ib + 2u]) + static_cast<long double>(m0[ib + 2u]);
        for (uint32_t p = offsets[r]; p < offsets[r + 1u]; ++p) {
            const uint32_t j = periodic_reps != nullptr ? (*periodic_reps)[cols[p]] : cols[p];
            const size_t jb = static_cast<size_t>(j) * 3u;
            const long double qx = static_cast<long double>(m1[jb + 0u]) - static_cast<long double>(m0[jb + 0u]);
            const long double qy = static_cast<long double>(m1[jb + 1u]) - static_cast<long double>(m0[jb + 1u]);
            const long double qz = static_cast<long double>(m1[jb + 2u]) - static_cast<long double>(m0[jb + 2u]);
            const long double dxi = static_cast<long double>(dx[p]);
            const long double dyi = static_cast<long double>(dy[p]);
            const long double dzi = static_cast<long double>(dz[p]);
            const long double cx = dyi * qz - dzi * qy;
            const long double cy = dzi * qx - dxi * qz;
            const long double cz = dxi * qy - dyi * qx;
            acc += 0.5L * (sx * cx + sy * cy + sz * cz);
        }
    }
    return static_cast<double>(acc);
}

void verify_field_and_energy_parity(
    const MeshFixture &fixture,
    const DmiCaseConfig &cfg,
    bool test_null_energy_and_null_mask)
{
    const bool periodic = !fixture.mesh.periodic_reduced_node.empty();
    const std::vector<double> m_xyz =
        make_twisted_magnetization(fixture.mesh, periodic, 12.0e-9, 10.0e-9, 0.0);

    ScopedFemContext holder;
    initialize_context_for_gpu_dmi(holder, fixture.mesh, m_xyz, cfg);
    Context &ctx = holder.ctx;
    auto &gpu = ctx.gpu_state.device;
    const int n = static_cast<int>(ctx.mesh.n_nodes);

    std::string error;
    const bool check_interfacial = cfg.interfacial_enabled || cfg.rotated_interfacial_enabled;
    const bool check_bulk = cfg.bulk_enabled;

    auto verify_channel = [&](bool bulk_mode) {
        std::vector<double> h_cpu;
        double e_cpu = 0.0;
        if (bulk_mode) {
            check(fullmag::fem::compute_bulk_dmi_field(ctx, m_xyz, h_cpu, &e_cpu, error), error.c_str());
        } else {
            check(fullmag::fem::compute_interfacial_dmi_field(ctx, m_xyz, h_cpu, &e_cpu, error), error.c_str());
        }

        const auto &chan = bulk_mode ? gpu.dmi_csr.bulk : gpu.dmi_csr.interfacial;
        check(chan.uploaded && chan.rows == ctx.mesh.n_nodes, "CSR DMI channel must be uploaded");
        if (periodic) {
            check(chan.periodic_reduced_ready, "periodic CSR DMI channel must be ready");
        }
        if (cfg.expect_zero) {
            check(chan.nnz == 0u, "D == 0.0 case must assemble nnz == 0");
            check(
                chan.csr_col_indices == nullptr && chan.csr_dx == nullptr &&
                    chan.csr_dy == nullptr && chan.csr_dz == nullptr,
                "nnz == 0 CSR channel must keep value/col pointers null");
        }

        // Run RK energy reduction path (computes H_dmi + block-reduced energy).
        check(
            fullmag::fem::gpu_rk_reduce_final_dmi_energy_terms(ctx, nullptr, n, error),
            error.c_str());
        check_cuda(cudaDeviceSynchronize(), "sync after RK CSR DMI energy reduction");

        const auto &field = bulk_mode ? gpu.fields.h_bulk_dmi : gpu.fields.h_dmi;
        std::vector<double> h_gpu;
        check(
            fullmag::fem::gpu_state_download_component_aos(
                gpu, field, h_gpu, ctx.transfer_audit.audit, "csr_dmi_h", error),
            error.c_str());
        double e_gpu = 0.0;
        const GpuFinalScalarSlot slot =
            bulk_mode ? GpuFinalScalarSlot::BulkDmiEnergy : GpuFinalScalarSlot::DmiEnergy;
        check_cuda(
            cudaMemcpy(
                &e_gpu,
                fullmag::fem::gpu_rk_final_scalar_result(gpu, slot),
                sizeof(double),
                cudaMemcpyDeviceToHost),
            "copy CSR DMI GPU energy");

        if (cfg.expect_zero) {
            check(max_abs(h_cpu) == 0.0 && max_abs(h_gpu) == 0.0, "D == 0.0 field must be identically zero");
            check(e_cpu == 0.0 && e_gpu == 0.0, "D == 0.0 energy must be identically zero");
            // Also verify direct kernel launch with nnz == 0 and magnetic_node_mask == nullptr.
            fullmag::fem::fullmag_cuda_dmi_csr_field_energy(
                chan.csr_row_offsets,
                chan.csr_col_indices,
                chan.csr_dx,
                chan.csr_dy,
                chan.csr_dz,
                gpu.magnetization.m.x,
                gpu.magnetization.m.y,
                gpu.magnetization.m.z,
                gpu.materials.ms,
                gpu.mesh_metrics.lumped_mass,
                /*magnetic_node_mask=*/nullptr,
                field.x,
                field.y,
                field.z,
                gpu.reductions.scalar_workspace,
                ctx.material_fields.material.saturation_magnetisation,
                n,
                nullptr);
            check_cuda(cudaDeviceSynchronize(), "sync after nnz==0 direct kernel launch");
            std::vector<double> h_zero_direct;
            check(
                fullmag::fem::gpu_state_download_component_aos(
                    gpu, field, h_zero_direct, ctx.transfer_audit.audit, "csr_dmi_zero_direct", error),
                error.c_str());
            check(max_abs(h_zero_direct) == 0.0, "nnz==0 direct kernel field must be zero");
            return;
        }

        const double h_scale = max_abs(h_cpu);
        const double h_diff = max_abs_diff(h_gpu, h_cpu);
        const double h_rel = h_diff / std::max(h_scale, 1.0e-30);
        const double e_rel = std::abs(e_gpu - e_cpu) / std::max(std::abs(e_cpu), 1.0e-30);
        if (h_rel > 1.0e-12 || e_rel > 1.0e-12) {
            std::fprintf(
                stderr,
                "FAIL [%s / %s / %s]: h_rel=%.3e (h_scale=%.3e) e_rel=%.3e (e_cpu=%.15e e_gpu=%.15e)\n",
                fixture.name,
                cfg.label,
                bulk_mode ? "bulk" : "interfacial",
                h_rel,
                h_scale,
                e_rel,
                e_cpu,
                e_gpu);
            std::exit(1);
        }

        // Verify air-only nodes have exact zero field on mixed meshes.
        for (uint32_t node = 0; node < ctx.mesh.n_nodes; ++node) {
            if (ctx.mesh.magnetic_node_mask[node] == 0u) {
                const size_t base = static_cast<size_t>(node) * 3u;
                check(
                    h_gpu[base + 0u] == 0.0 && h_gpu[base + 1u] == 0.0 && h_gpu[base + 2u] == 0.0,
                    "air node must receive exact zero CSR DMI field");
            }
        }

        // Verify RK field-only fast path (energy_block_sums == nullptr) produces
        // bitwise identical H_dmi without touching scalar_workspace.
        if (test_null_energy_and_null_mask) {
            const int active_rows = periodic ? static_cast<int>(chan.periodic_reduced_rows) : n;
            const int blocks = (active_rows + 255) / 256;
            const std::vector<double> sentinels(static_cast<size_t>(blocks), 987654.321);
            check_cuda(
                cudaMemcpy(
                    gpu.reductions.scalar_workspace,
                    sentinels.data(),
                    sentinels.size() * sizeof(double),
                    cudaMemcpyHostToDevice),
                "write energy sentinel");
            check_cuda(cudaMemset(field.x, 0, static_cast<size_t>(n) * sizeof(double)), "zero h_x");
            check_cuda(cudaMemset(field.y, 0, static_cast<size_t>(n) * sizeof(double)), "zero h_y");
            check_cuda(cudaMemset(field.z, 0, static_cast<size_t>(n) * sizeof(double)), "zero h_z");

            check(
                fullmag::fem::gpu_rk_compute_dmi_field_contributions(
                    ctx, gpu.magnetization.m, nullptr, n, error),
                error.c_str());
            check_cuda(cudaDeviceSynchronize(), "sync after RK field-only DMI");

            std::vector<double> h_field_only;
            check(
                fullmag::fem::gpu_state_download_component_aos(
                    gpu, field, h_field_only, ctx.transfer_audit.audit, "csr_dmi_field_only", error),
                error.c_str());
            check(
                h_field_only == h_gpu,
                "energy_block_sums == nullptr must produce bitwise identical H_dmi");

            std::vector<double> after_sentinels(static_cast<size_t>(blocks), 0.0);
            check_cuda(
                cudaMemcpy(
                    after_sentinels.data(),
                    gpu.reductions.scalar_workspace,
                    after_sentinels.size() * sizeof(double),
                    cudaMemcpyDeviceToHost),
                "read energy sentinel");
            check(
                after_sentinels == sentinels,
                "energy_block_sums == nullptr must not touch energy_block_sums buffer");

            // On all-magnetic meshes, verify magnetic_node_mask == nullptr works cleanly.
            const bool all_magnetic = std::all_of(
                ctx.mesh.magnetic_node_mask.begin(),
                ctx.mesh.magnetic_node_mask.end(),
                [](uint8_t v) { return v != 0u; });
            if (all_magnetic && !periodic) {
                check_cuda(cudaMemset(field.x, 0, static_cast<size_t>(n) * sizeof(double)), "zero h_x nullmask");
                check_cuda(cudaMemset(field.y, 0, static_cast<size_t>(n) * sizeof(double)), "zero h_y nullmask");
                check_cuda(cudaMemset(field.z, 0, static_cast<size_t>(n) * sizeof(double)), "zero h_z nullmask");
                fullmag::fem::fullmag_cuda_dmi_csr_field_energy(
                    chan.csr_row_offsets,
                    chan.csr_col_indices,
                    chan.csr_dx,
                    chan.csr_dy,
                    chan.csr_dz,
                    gpu.magnetization.m.x,
                    gpu.magnetization.m.y,
                    gpu.magnetization.m.z,
                    gpu.materials.ms,
                    gpu.mesh_metrics.lumped_mass,
                    /*magnetic_node_mask=*/nullptr,
                    field.x,
                    field.y,
                    field.z,
                    /*energy_block_sums=*/nullptr,
                    ctx.material_fields.material.saturation_magnetisation,
                    n,
                    nullptr);
                check_cuda(cudaDeviceSynchronize(), "sync after null-mask CSR DMI launch");
                std::vector<double> h_null_mask;
                check(
                    fullmag::fem::gpu_state_download_component_aos(
                        gpu, field, h_null_mask, ctx.transfer_audit.audit, "csr_dmi_null_mask", error),
                    error.c_str());
                check(
                    h_null_mask == h_gpu,
                    "magnetic_node_mask == nullptr must match all-magnetic masked CSR DMI field");
            }
        }
    };

    if (check_interfacial) {
        verify_channel(false);
    }
    if (check_bulk) {
        verify_channel(true);
    }
}

void verify_polarized_energy_difference(
    const MeshFixture &fixture,
    const DmiCaseConfig &cfg,
    bool bulk_mode)
{
    const bool periodic = !fixture.mesh.periodic_reduced_node.empty();
    const std::vector<double> m0 =
        make_twisted_magnetization(fixture.mesh, periodic, 12.0e-9, 10.0e-9, 0.0);
    const std::vector<double> m_dir =
        make_twisted_magnetization(fixture.mesh, periodic, 12.0e-9, 10.0e-9, 0.9);

    ScopedFemContext holder;
    initialize_context_for_gpu_dmi(holder, fixture.mesh, m0, cfg);
    Context &ctx = holder.ctx;
    auto &gpu = ctx.gpu_state.device;

    std::string error;
    GpuDmiCsrHostData host_csr{};
    check(
        fullmag::fem::build_gpu_dmi_csr_from_mfem(ctx, bulk_mode, host_csr, error),
        error.c_str());

    const auto &chan = bulk_mode ? gpu.dmi_csr.bulk : gpu.dmi_csr.interfacial;
    const int n = static_cast<int>(ctx.mesh.n_nodes);
    const size_t comp_bytes = static_cast<size_t>(n) * sizeof(double);

    // Copy m0 into gpu.rk.m_backup so gpu.magnetization.m can hold each trial m1.
    check_cuda(
        cudaMemcpy(gpu.rk.m_backup.x, gpu.magnetization.m.x, comp_bytes, cudaMemcpyDeviceToDevice),
        "copy m0.x to backup");
    check_cuda(
        cudaMemcpy(gpu.rk.m_backup.y, gpu.magnetization.m.y, comp_bytes, cudaMemcpyDeviceToDevice),
        "copy m0.y to backup");
    check_cuda(
        cudaMemcpy(gpu.rk.m_backup.z, gpu.magnetization.m.z, comp_bytes, cudaMemcpyDeviceToDevice),
        "copy m0.z to backup");

    std::vector<double> h_tmp;
    double e0_cpu = 0.0;
    if (bulk_mode) {
        check(fullmag::fem::compute_bulk_dmi_field(ctx, m0, h_tmp, &e0_cpu, error), error.c_str());
    } else {
        check(fullmag::fem::compute_interfacial_dmi_field(ctx, m0, h_tmp, &e0_cpu, error), error.c_str());
    }

    auto make_trial = [&](double sign_m0, double eps) {
        std::vector<double> m1(m0.size(), 0.0);
        for (uint32_t node = 0; node < ctx.mesh.n_nodes; ++node) {
            const size_t b = static_cast<size_t>(node) * 3u;
            const double x = sign_m0 * m0[b + 0u] + eps * m_dir[b + 0u];
            const double y = sign_m0 * m0[b + 1u] + eps * m_dir[b + 1u];
            const double z = sign_m0 * m0[b + 2u] + eps * m_dir[b + 2u];
            const double norm = std::sqrt(x * x + y * y + z * z);
            m1[b + 0u] = x / norm;
            m1[b + 1u] = y / norm;
            m1[b + 2u] = z / norm;
        }
        return m1;
    };

    struct DiffProbe {
        const char *tag;
        double sign_m0;
        double eps;
        bool exact_antiparallel;
    };
    const std::array<DiffProbe, 4> probes = {{
        {"moderate_step", 1.0, 1.0e-2, false},
        {"tiny_step_1e-7", 1.0, 1.0e-7, false},
        {"near_antiparallel_1e-6", -1.0, 1.0e-6, false},
        {"exact_antiparallel", -1.0, 0.0, true},
    }};

    for (const auto &probe : probes) {
        const std::vector<double> m1 = make_trial(probe.sign_m0, probe.eps);
        double e1_cpu = 0.0;
        if (bulk_mode) {
            check(fullmag::fem::compute_bulk_dmi_field(ctx, m1, h_tmp, &e1_cpu, error), error.c_str());
        } else {
            check(fullmag::fem::compute_interfacial_dmi_field(ctx, m1, h_tmp, &e1_cpu, error), error.c_str());
        }
        const double delta_cpu_endpoints = e1_cpu - e0_cpu;
        const double delta_exact_polarized = host_polarized_csr_dmi_difference(
            host_csr,
            m0,
            m1,
            periodic ? &ctx.mesh.periodic_representative_nodes : nullptr);

        check(
            fullmag::fem::gpu_state_upload_magnetization_aos(
                gpu, m1.data(), static_cast<uint64_t>(m1.size()), ctx.transfer_audit.audit, error),
            error.c_str());

        const int active_rows = periodic ? static_cast<int>(chan.periodic_reduced_rows) : n;
        const int blocks = (active_rows + 255) / 256;
        if (periodic) {
            fullmag::fem::fullmag_cuda_dmi_csr_energy_difference(
                chan.periodic_reduced_row_offsets,
                chan.periodic_reduced_col_indices,
                chan.periodic_reduced_dx,
                chan.periodic_reduced_dy,
                chan.periodic_reduced_dz,
                gpu.rk.m_backup.x,
                gpu.rk.m_backup.y,
                gpu.rk.m_backup.z,
                gpu.magnetization.m.x,
                gpu.magnetization.m.y,
                gpu.magnetization.m.z,
                gpu.reductions.scalar_workspace,
                gpu.rk.k[1].x,
                active_rows,
                nullptr,
                gpu.mesh_regions.periodic_reduced_representative_nodes);
        } else {
            fullmag::fem::fullmag_cuda_dmi_csr_energy_difference(
                chan.csr_row_offsets,
                chan.csr_col_indices,
                chan.csr_dx,
                chan.csr_dy,
                chan.csr_dz,
                gpu.rk.m_backup.x,
                gpu.rk.m_backup.y,
                gpu.rk.m_backup.z,
                gpu.magnetization.m.x,
                gpu.magnetization.m.y,
                gpu.magnetization.m.z,
                gpu.reductions.scalar_workspace,
                gpu.rk.k[1].x,
                active_rows,
                nullptr,
                nullptr);
        }

        size_t temp_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
        fullmag::fem::fullmag_cuda_device_sum(
            gpu.reductions.scalar_workspace,
            blocks,
            gpu.reductions.scalar_result + 0,
            gpu.reductions.temp_storage,
            temp_bytes,
            nullptr);
        temp_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
        fullmag::fem::fullmag_cuda_device_sum(
            gpu.rk.k[1].x,
            blocks,
            gpu.reductions.scalar_result + 1,
            gpu.reductions.temp_storage,
            temp_bytes,
            nullptr);
        check_cuda(cudaDeviceSynchronize(), "sync after CSR DMI energy difference");

        double out[2] = {0.0, 0.0};
        check_cuda(
            cudaMemcpy(out, gpu.reductions.scalar_result, 2u * sizeof(double), cudaMemcpyDeviceToHost),
            "copy CSR DMI energy difference result");
        const double delta_gpu = out[0];
        const double abs_gpu = out[1];

        check(std::isfinite(delta_gpu) && std::isfinite(abs_gpu), "CSR DMI energy difference must be finite");
        check(abs_gpu >= std::abs(delta_gpu), "CSR DMI S_abs must conservatively bound |delta_E|");
        check(abs_gpu > 0.0, "CSR DMI S_abs must stay strictly positive via DBL_EPSILON operand-scale floor");

        if (probe.exact_antiparallel) {
            check(
                std::abs(delta_gpu) <= 1.0e-30 * std::max(1.0, std::abs(e0_cpu)),
                "exact antiparallel m1 == -m0 must yield zero DMI energy difference");
        } else {
            const double polarized_rel =
                std::abs(delta_gpu - delta_exact_polarized) /
                std::max(std::abs(delta_exact_polarized), 1.0e-30);
            const double endpoint_tol =
                std::max(1.0e-11 * std::abs(delta_exact_polarized),
                         1.0e-12 * (std::abs(e0_cpu) + std::abs(e1_cpu)));
            const double endpoint_err = std::abs(delta_gpu - delta_cpu_endpoints);
            if (polarized_rel > 1.0e-11 || endpoint_err > endpoint_tol) {
                std::fprintf(
                    stderr,
                    "FAIL diff [%s / %s / %s]: polarized_rel=%.3e endpoint_err=%.3e (tol=%.3e) delta_gpu=%.15e exact=%.15e cpu=%.15e abs=%.15e\n",
                    fixture.name,
                    cfg.label,
                    probe.tag,
                    polarized_rel,
                    endpoint_err,
                    endpoint_tol,
                    delta_gpu,
                    delta_exact_polarized,
                    delta_cpu_endpoints,
                    abs_gpu);
                std::exit(1);
            }
        }
    }
}

} // namespace

int main()
{
    int device_count = 0;
    if (cudaGetDeviceCount(&device_count) != cudaSuccess || device_count <= 0) {
        std::printf("SKIP: cuda_csr_dmi_prism_contract requires a CUDA GPU\n");
        return 0;
    }

    const MeshFixture tet4 = make_tet4_box_mesh(3, 3, 2, 12.0e-9, 10.0e-9, 4.0e-9, false);
    const MeshFixture prism6 = make_multilayer_prism6_mesh(3, 3, 2, 12.0e-9, 10.0e-9, 4.0e-9);
    const MeshFixture mixed = make_mixed_prism_pyramid_tet_mesh();
    const MeshFixture periodic_tet4 = make_tet4_box_mesh(3, 3, 2, 12.0e-9, 10.0e-9, 4.0e-9, true);

    const std::array<double, 3> oblique_normal = {0.3, -0.4, std::sqrt(0.75)};

    const DmiCaseConfig cfg_interfacial_oblique = {
        "interfacial_oblique_normal",
        /*interfacial_enabled=*/true,
        /*interfacial_D=*/1.8e-3,
        /*interface_normal=*/oblique_normal,
        /*use_dind_field=*/false,
        /*rotated_interfacial_enabled=*/false,
        /*rotated_interfacial_D=*/0.0,
        /*bulk_enabled=*/false,
        /*bulk_D=*/0.0,
        /*use_dbulk_field=*/false,
        /*expect_zero=*/false,
    };
    const DmiCaseConfig cfg_rotated_only = {
        "rotated_interfacial_goebel",
        /*interfacial_enabled=*/false,
        /*interfacial_D=*/0.0,
        /*interface_normal=*/{0.0, 0.0, 1.0},
        /*use_dind_field=*/false,
        /*rotated_interfacial_enabled=*/true,
        /*rotated_interfacial_D=*/1.5e-3,
        /*bulk_enabled=*/false,
        /*bulk_D=*/0.0,
        /*use_dbulk_field=*/false,
        /*expect_zero=*/false,
    };
    const DmiCaseConfig cfg_combined_spatial_interfacial = {
        "combined_interfacial_rotated_spatial_Dind",
        /*interfacial_enabled=*/true,
        /*interfacial_D=*/0.0,
        /*interface_normal=*/oblique_normal,
        /*use_dind_field=*/true,
        /*rotated_interfacial_enabled=*/true,
        /*rotated_interfacial_D=*/1.5e-3,
        /*bulk_enabled=*/false,
        /*bulk_D=*/0.0,
        /*use_dbulk_field=*/false,
        /*expect_zero=*/false,
    };
    const DmiCaseConfig cfg_bulk_uniform = {
        "bulk_uniform",
        /*interfacial_enabled=*/false,
        /*interfacial_D=*/0.0,
        /*interface_normal=*/{0.0, 0.0, 1.0},
        /*use_dind_field=*/false,
        /*rotated_interfacial_enabled=*/false,
        /*rotated_interfacial_D=*/0.0,
        /*bulk_enabled=*/true,
        /*bulk_D=*/2.0e-3,
        /*use_dbulk_field=*/false,
        /*expect_zero=*/false,
    };
    const DmiCaseConfig cfg_bulk_spatial = {
        "bulk_spatial_Dbulk",
        /*interfacial_enabled=*/false,
        /*interfacial_D=*/0.0,
        /*interface_normal=*/{0.0, 0.0, 1.0},
        /*use_dind_field=*/false,
        /*rotated_interfacial_enabled=*/false,
        /*rotated_interfacial_D=*/0.0,
        /*bulk_enabled=*/true,
        /*bulk_D=*/0.0,
        /*use_dbulk_field=*/true,
        /*expect_zero=*/false,
    };
    const DmiCaseConfig cfg_zero_d = {
        "degenerate_D_zero_nnz_zero",
        /*interfacial_enabled=*/true,
        /*interfacial_D=*/0.0,
        /*interface_normal=*/{0.0, 0.0, 1.0},
        /*use_dind_field=*/false,
        /*rotated_interfacial_enabled=*/false,
        /*rotated_interfacial_D=*/0.0,
        /*bulk_enabled=*/true,
        /*bulk_D=*/0.0,
        /*use_dbulk_field=*/false,
        /*expect_zero=*/true,
    };

    // 1. Parity across tet4, multi-layer prism6, and conforming mixed prism6+pyramid5+tet4.
    for (const MeshFixture *fixture : {&tet4, &prism6, &mixed}) {
        verify_field_and_energy_parity(*fixture, cfg_interfacial_oblique, true);
        verify_field_and_energy_parity(*fixture, cfg_rotated_only, false);
        verify_field_and_energy_parity(*fixture, cfg_combined_spatial_interfacial, true);
        verify_field_and_energy_parity(*fixture, cfg_bulk_uniform, true);
        verify_field_and_energy_parity(*fixture, cfg_bulk_spatial, false);
    }

    // 2. Degenerate D == 0.0 (nnz == 0) + magnetic_node_mask == nullptr on prism6.
    verify_field_and_energy_parity(prism6, cfg_zero_d, false);

    // 3. Compensated double-double polarized energy increment on prism6
    //    (small perturbation ~1e-7, near-antiparallel m1 ~= -m0, exact -m0).
    verify_polarized_energy_difference(prism6, cfg_combined_spatial_interfacial, false);
    verify_polarized_energy_difference(prism6, cfg_bulk_spatial, true);

    // 4. 2D periodic P^T D P CSR DMI parity + polarized difference on tet4.
    const DmiCaseConfig cfg_periodic_both = {
        "periodic_2d_interfacial_rotated_and_bulk",
        /*interfacial_enabled=*/true,
        /*interfacial_D=*/1.8e-3,
        /*interface_normal=*/oblique_normal,
        /*use_dind_field=*/false,
        /*rotated_interfacial_enabled=*/true,
        /*rotated_interfacial_D=*/1.5e-3,
        /*bulk_enabled=*/true,
        /*bulk_D=*/2.0e-3,
        /*use_dbulk_field=*/false,
        /*expect_zero=*/false,
    };
    verify_field_and_energy_parity(periodic_tet4, cfg_periodic_both, true);
    verify_polarized_energy_difference(periodic_tet4, cfg_periodic_both, false);
    verify_polarized_energy_difference(periodic_tet4, cfg_periodic_both, true);

    std::printf("FEM cuda_csr_dmi_prism_contract PASS\n");
    return 0;
}

#else

int main()
{
    std::printf("SKIP: cuda_csr_dmi_prism_contract requires MFEM stack and CUDA runtime\n");
    return 0;
}

#endif

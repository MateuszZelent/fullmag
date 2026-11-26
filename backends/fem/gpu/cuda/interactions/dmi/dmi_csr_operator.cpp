/*
 * GPU CUDA sparse CSR DMI operator source contract.
 *
 * This source owns MFEM-backed assembly of skew-symmetric off-diagonal nodal
 * edge-vector DMI CSR data (d_ij = -d_ji, R_i = sum_j d_ij x m_j) across
 * arbitrary H1 P1 meshes (tet4, prism6, mixed), optional periodic class
 * reduction (P^T D P), and device upload/teardown for FemGpuDmiCsrDeviceState.
 * It does not own CUDA kernel launches, RK orchestration, or C ABI entrypoints.
 */

#include "gpu/cuda/interactions/dmi/dmi_csr_operator.hpp"

#include "context.hpp"
#include "gpu/cuda/state/device_memory.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <map>
#include <string>
#include <utility>
#include <vector>

#if defined(FULLMAG_HAS_MFEM_STACK) && FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#if defined(FULLMAG_HAS_CUDA_RUNTIME) && FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

namespace {

#if defined(FULLMAG_HAS_CUDA_RUNTIME) && FULLMAG_HAS_CUDA_RUNTIME
bool cuda_ok(cudaError_t rc, const char *operation, std::string &error)
{
    if (rc == cudaSuccess) {
        return true;
    }
    error = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}
#endif

void gpu_dmi_csr_free_channel(
    FemGpuLifecycleDeviceState &lifecycle,
    GpuDmiCsrChannelDeviceState &channel)
{
    const uint64_t previous_device_bytes = channel.device_bytes;
    gpu_device_free_u32(channel.csr_row_offsets);
    gpu_device_free_u32(channel.csr_col_indices);
    gpu_device_free_double(channel.csr_dx);
    gpu_device_free_double(channel.csr_dy);
    gpu_device_free_double(channel.csr_dz);
    gpu_device_free_u32(channel.periodic_reduced_row_offsets);
    gpu_device_free_u32(channel.periodic_reduced_col_indices);
    gpu_device_free_double(channel.periodic_reduced_dx);
    gpu_device_free_double(channel.periodic_reduced_dy);
    gpu_device_free_double(channel.periodic_reduced_dz);
    gpu_device_free_double(channel.periodic_reduced_mass);
    gpu_device_free_double(channel.periodic_reduced_rx);
    gpu_device_free_double(channel.periodic_reduced_ry);
    gpu_device_free_double(channel.periodic_reduced_rz);
    if (previous_device_bytes <= lifecycle.device_bytes) {
        lifecycle.device_bytes -= previous_device_bytes;
    } else {
        lifecycle.device_bytes = 0;
    }
    channel = {};
}

#if defined(FULLMAG_HAS_MFEM_STACK) && FULLMAG_HAS_MFEM_STACK
bool materialize_skew_symmetric_csr(
    uint32_t rows,
    const std::vector<std::map<uint32_t, std::array<double, 3>>> &upper_edges,
    std::vector<uint32_t> &row_offsets,
    std::vector<uint32_t> &col_indices,
    std::vector<double> &dx,
    std::vector<double> &dy,
    std::vector<double> &dz,
    const char *label,
    std::string &error)
{
    std::vector<std::vector<std::pair<uint32_t, std::array<double, 3>>>> adjacency(rows);
    for (uint32_t u = 0; u < rows; ++u) {
        for (const auto &[v, vec] : upper_edges[u]) {
            if (v <= u || v >= rows) {
                error = std::string(label) + " encountered invalid upper-triangle edge indices";
                return false;
            }
            if (!std::isfinite(vec[0]) || !std::isfinite(vec[1]) || !std::isfinite(vec[2])) {
                error = std::string(label) + " produced a non-finite edge vector";
                return false;
            }
            if (vec[0] == 0.0 && vec[1] == 0.0 && vec[2] == 0.0) {
                continue;
            }
            adjacency[u].push_back({v, {vec[0], vec[1], vec[2]}});
            adjacency[v].push_back({u, {-vec[0], -vec[1], -vec[2]}});
        }
    }

    row_offsets.clear();
    col_indices.clear();
    dx.clear();
    dy.clear();
    dz.clear();
    row_offsets.reserve(static_cast<size_t>(rows) + 1u);
    row_offsets.push_back(0u);
    for (uint32_t row = 0; row < rows; ++row) {
        auto &entries = adjacency[row];
        std::sort(
            entries.begin(),
            entries.end(),
            [](const auto &lhs, const auto &rhs) { return lhs.first < rhs.first; });
        for (const auto &[col, vec] : entries) {
            col_indices.push_back(col);
            dx.push_back(vec[0]);
            dy.push_back(vec[1]);
            dz.push_back(vec[2]);
        }
        if (col_indices.size() > std::numeric_limits<uint32_t>::max()) {
            error = std::string(label) + " exceeds u32 CSR indexing";
            return false;
        }
        row_offsets.push_back(static_cast<uint32_t>(col_indices.size()));
    }
    return true;
}
#endif

} // namespace

bool build_gpu_dmi_csr_from_mfem(
    const Context &ctx,
    bool bulk_mode,
    GpuDmiCsrHostData &out,
    std::string &error)
{
    out = {};
    error.clear();

#if !(defined(FULLMAG_HAS_MFEM_STACK) && FULLMAG_HAS_MFEM_STACK)
    (void)ctx;
    (void)bulk_mode;
    error = "CSR DMI assembly requires MFEM stack support";
    return false;
#else
    if (!ctx.mfem_context.ready ||
        ctx.mfem_context.mesh == nullptr ||
        ctx.mfem_context.fes == nullptr) {
        error = "MFEM context not ready for CSR DMI assembly";
        return false;
    }
    auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_context.mesh);
    auto *fes = static_cast<mfem::FiniteElementSpace *>(ctx.mfem_context.fes);
    if (ctx.mesh.n_nodes == 0u ||
        static_cast<uint64_t>(ctx.mesh.n_nodes) > std::numeric_limits<uint32_t>::max()) {
        error = "CSR DMI assembly requires a non-empty u32-indexable mesh";
        return false;
    }
    const uint32_t n_nodes = static_cast<uint32_t>(ctx.mesh.n_nodes);
    if (fes->GetNDofs() != static_cast<int>(n_nodes)) {
        error = "CSR DMI assembly requires MFEM H1 P1 DOF count to match mesh node count";
        return false;
    }

    const bool bulk_active = bulk_mode && ctx.dmi.bulk_enabled &&
        (ctx.dmi.bulk_D != 0.0 || !ctx.material_fields.Dbulk_field.empty());
    const bool conventional_active = !bulk_mode && ctx.dmi.interfacial_enabled &&
        (ctx.dmi.interfacial_D != 0.0 || !ctx.material_fields.Dind_field.empty());
    const bool rotated_active = !bulk_mode && ctx.dmi.rotated_interfacial_enabled &&
        ctx.dmi.rotated_interfacial_D != 0.0;
    const bool any_active = bulk_mode ? bulk_active : (conventional_active || rotated_active);

    if (bulk_active &&
        !ctx.material_fields.Dbulk_field.empty() &&
        ctx.material_fields.Dbulk_field.size() != static_cast<size_t>(n_nodes)) {
        error = "CSR bulk DMI assembly requires Dbulk_field length to match mesh node count";
        return false;
    }
    if (conventional_active &&
        !ctx.material_fields.Dind_field.empty() &&
        ctx.material_fields.Dind_field.size() != static_cast<size_t>(n_nodes)) {
        error = "CSR interfacial DMI assembly requires Dind_field length to match mesh node count";
        return false;
    }

    const double nx = ctx.dmi.interface_normal[0];
    const double ny = ctx.dmi.interface_normal[1];
    const double nz = ctx.dmi.interface_normal[2];
    if (conventional_active &&
        (!std::isfinite(nx) || !std::isfinite(ny) || !std::isfinite(nz))) {
        error = "CSR interfacial DMI assembly requires a finite interface normal";
        return false;
    }

    std::vector<std::map<uint32_t, std::array<double, 3>>> upper_edges(n_nodes);

    if (any_active) {
        mfem::IsoparametricTransformation T;
        mfem::Array<int> dofs;
        mfem::Vector shape;
        mfem::DenseMatrix dshape;
        std::vector<int> gdofs;
        std::vector<double> signs;
        std::vector<std::array<double, 3>> elem_g;

        const int n_elements = mesh->GetNE();
        for (int elem = 0; elem < n_elements; ++elem) {
            if (!ctx.mesh.magnetic_element_mask.empty() &&
                static_cast<size_t>(elem) < ctx.mesh.magnetic_element_mask.size() &&
                ctx.mesh.magnetic_element_mask[static_cast<size_t>(elem)] == 0u) {
                continue;
            }
            const mfem::FiniteElement *fe = fes->GetFE(elem);
            if (fe == nullptr) {
                error = "CSR DMI assembly encountered a null MFEM finite element";
                return false;
            }
            fes->GetElementDofs(elem, dofs);
            const int local_ndof = dofs.Size();
            if (local_ndof <= 1) {
                continue;
            }
            gdofs.resize(static_cast<size_t>(local_ndof));
            signs.resize(static_cast<size_t>(local_ndof));
            for (int a = 0; a < local_ndof; ++a) {
                const int raw = dofs[a];
                gdofs[static_cast<size_t>(a)] = raw >= 0 ? raw : -1 - raw;
                signs[static_cast<size_t>(a)] = raw >= 0 ? 1.0 : -1.0;
            }

            double elem_d_bulk = 0.0;
            double elem_d_int = 0.0;
            double elem_d_rot = 0.0;
            if (bulk_mode) {
                if (!ctx.material_fields.Dbulk_field.empty()) {
                    for (int a = 0; a < local_ndof; ++a) {
                        const int gdof = gdofs[static_cast<size_t>(a)];
                        if (gdof < 0 || static_cast<uint32_t>(gdof) >= n_nodes) {
                            error = "CSR bulk DMI assembly encountered out-of-range element DOF";
                            return false;
                        }
                        elem_d_bulk += ctx.material_fields.Dbulk_field[static_cast<size_t>(gdof)];
                    }
                    elem_d_bulk /= static_cast<double>(local_ndof);
                } else {
                    elem_d_bulk = ctx.dmi.bulk_D;
                }
                if (!std::isfinite(elem_d_bulk)) {
                    error = "CSR bulk DMI assembly encountered non-finite bulk D";
                    return false;
                }
                if (elem_d_bulk == 0.0) {
                    continue;
                }
            } else {
                if (conventional_active) {
                    if (!ctx.material_fields.Dind_field.empty()) {
                        for (int a = 0; a < local_ndof; ++a) {
                            const int gdof = gdofs[static_cast<size_t>(a)];
                            if (gdof < 0 || static_cast<uint32_t>(gdof) >= n_nodes) {
                                error = "CSR interfacial DMI assembly encountered out-of-range element DOF";
                                return false;
                            }
                            elem_d_int += ctx.material_fields.Dind_field[static_cast<size_t>(gdof)];
                        }
                        elem_d_int /= static_cast<double>(local_ndof);
                    } else {
                        elem_d_int = ctx.dmi.interfacial_D;
                    }
                }
                if (rotated_active) {
                    elem_d_rot = ctx.dmi.rotated_interfacial_D;
                }
                if (!std::isfinite(elem_d_int) || !std::isfinite(elem_d_rot)) {
                    error = "CSR interfacial DMI assembly encountered non-finite interfacial D";
                    return false;
                }
                if (elem_d_int == 0.0 && elem_d_rot == 0.0) {
                    continue;
                }
            }

            mesh->GetElementTransformation(elem, &T);
            const mfem::IntegrationRule &ir =
                mfem::IntRules.Get(fe->GetGeomType(), 2 * fe->GetOrder());
            shape.SetSize(local_ndof);
            dshape.SetSize(local_ndof, 3);

            const size_t pair_table_size =
                static_cast<size_t>(local_ndof) * static_cast<size_t>(local_ndof);
            elem_g.assign(pair_table_size, {0.0, 0.0, 0.0});

            for (int q = 0; q < ir.GetNPoints(); ++q) {
                const mfem::IntegrationPoint &ip = ir.IntPoint(q);
                T.SetIntPoint(&ip);
                const double w = ip.weight * T.Weight();
                if (!std::isfinite(w)) {
                    error = "CSR DMI assembly encountered non-finite quadrature weight";
                    return false;
                }
                if (w == 0.0) {
                    continue;
                }
                fe->CalcShape(ip, shape);
                fe->CalcPhysDShape(T, dshape);

                for (int a = 0; a < local_ndof; ++a) {
                    const double sa = shape(a);
                    const double dxa = dshape(a, 0);
                    const double dya = dshape(a, 1);
                    const double dza = dshape(a, 2);
                    const double sign_a = signs[static_cast<size_t>(a)];
                    for (int b = a + 1; b < local_ndof; ++b) {
                        const double sb = shape(b);
                        const double factor = w * sign_a * signs[static_cast<size_t>(b)];
                        auto &g = elem_g[static_cast<size_t>(a) * static_cast<size_t>(local_ndof) +
                                         static_cast<size_t>(b)];
                        g[0] += factor * (sa * dshape(b, 0) - sb * dxa);
                        g[1] += factor * (sa * dshape(b, 1) - sb * dya);
                        g[2] += factor * (sa * dshape(b, 2) - sb * dza);
                    }
                }
            }

            for (int a = 0; a < local_ndof; ++a) {
                const int gdof_a = gdofs[static_cast<size_t>(a)];
                if (gdof_a < 0 || static_cast<uint32_t>(gdof_a) >= n_nodes) {
                    continue;
                }
                for (int b = a + 1; b < local_ndof; ++b) {
                    const int gdof_b = gdofs[static_cast<size_t>(b)];
                    if (gdof_b < 0 || static_cast<uint32_t>(gdof_b) >= n_nodes ||
                        gdof_a == gdof_b) {
                        continue;
                    }
                    const auto &g =
                        elem_g[static_cast<size_t>(a) * static_cast<size_t>(local_ndof) +
                               static_cast<size_t>(b)];
                    double dx = 0.0;
                    double dy = 0.0;
                    double dz = 0.0;
                    if (bulk_mode) {
                        // Bulk DMI: d_ij = +D_bulk * g_ij
                        dx = elem_d_bulk * g[0];
                        dy = elem_d_bulk * g[1];
                        dz = elem_d_bulk * g[2];
                    } else {
                        if (elem_d_int != 0.0) {
                            // Conventional interfacial DMI: d_ij = D_int * (g_ij x n_hat)
                            dx += elem_d_int * (g[1] * nz - g[2] * ny);
                            dy += elem_d_int * (g[2] * nx - g[0] * nz);
                            dz += elem_d_int * (g[0] * ny - g[1] * nx);
                        }
                        if (elem_d_rot != 0.0) {
                            // Rotated interfacial DMI (Goebel D21=D32): d_ij = D_rot * (0, -g_x, -g_y)
                            dy += -elem_d_rot * g[0];
                            dz += -elem_d_rot * g[1];
                        }
                    }
                    if (!std::isfinite(dx) || !std::isfinite(dy) || !std::isfinite(dz)) {
                        error = "CSR DMI assembly produced non-finite local edge vector";
                        return false;
                    }
                    if (dx == 0.0 && dy == 0.0 && dz == 0.0) {
                        continue;
                    }
                    const uint32_t u = static_cast<uint32_t>(gdof_a);
                    const uint32_t v = static_cast<uint32_t>(gdof_b);
                    if (u < v) {
                        auto &acc = upper_edges[u][v];
                        acc[0] += dx;
                        acc[1] += dy;
                        acc[2] += dz;
                    } else {
                        auto &acc = upper_edges[v][u];
                        acc[0] -= dx;
                        acc[1] -= dy;
                        acc[2] -= dz;
                    }
                }
            }
        }
    }

    out.rows = n_nodes;
    if (!materialize_skew_symmetric_csr(
            n_nodes,
            upper_edges,
            out.row_offsets,
            out.col_indices,
            out.dx,
            out.dy,
            out.dz,
            "CSR DMI assembly",
            error)) {
        out = {};
        return false;
    }

    if (!ctx.mesh.periodic_reduced_node.empty()) {
        if (ctx.mesh.periodic_reduced_node.size() != static_cast<size_t>(n_nodes) ||
            ctx.mesh.periodic_reduced_node_count == 0u ||
            ctx.mesh.periodic_reduced_node_count > n_nodes ||
            ctx.mesh.periodic_representative_nodes.size() !=
                static_cast<size_t>(ctx.mesh.periodic_reduced_node_count) ||
            ctx.integration_weights.mfem_lumped_mass.size() != static_cast<size_t>(n_nodes)) {
            out = {};
            error = "CSR periodic DMI assembly requires complete periodic node maps and lumped mass";
            return false;
        }
        const uint32_t reduced_rows = static_cast<uint32_t>(ctx.mesh.periodic_reduced_node_count);
        std::vector<uint8_t> class_seen(reduced_rows, 0u);
        out.periodic_reduced_mass.assign(reduced_rows, 0.0);
        for (uint32_t node = 0; node < n_nodes; ++node) {
            const uint32_t reduced = ctx.mesh.periodic_reduced_node[node];
            const double mass = ctx.integration_weights.mfem_lumped_mass[node];
            if (reduced >= reduced_rows || !std::isfinite(mass) || mass < 0.0) {
                out = {};
                error = "CSR periodic DMI assembly encountered invalid periodic class or mass";
                return false;
            }
            class_seen[reduced] = 1u;
            out.periodic_reduced_mass[reduced] += mass;
        }
        for (uint32_t reduced = 0; reduced < reduced_rows; ++reduced) {
            const uint32_t representative = ctx.mesh.periodic_representative_nodes[reduced];
            if (class_seen[reduced] == 0u ||
                representative >= n_nodes ||
                ctx.mesh.periodic_reduced_node[representative] != reduced ||
                !std::isfinite(out.periodic_reduced_mass[reduced]) ||
                out.periodic_reduced_mass[reduced] < 0.0) {
                out = {};
                error = "CSR periodic DMI assembly encountered inconsistent periodic representatives";
                return false;
            }
        }

        // Periodic P^T D P reduction over upper-triangle undirected edges (u < v):
        // intra-class edges (cu == cv) cancel identically since d_uv + d_vu = 0.
        std::vector<std::map<uint32_t, std::array<double, 3>>> reduced_upper(reduced_rows);
        for (uint32_t u = 0; u < n_nodes; ++u) {
            const uint32_t cu = ctx.mesh.periodic_reduced_node[u];
            for (const auto &[v, vec] : upper_edges[u]) {
                if (vec[0] == 0.0 && vec[1] == 0.0 && vec[2] == 0.0) {
                    continue;
                }
                const uint32_t cv = ctx.mesh.periodic_reduced_node[v];
                if (cu == cv) {
                    continue;
                }
                if (cu < cv) {
                    auto &acc = reduced_upper[cu][cv];
                    acc[0] += vec[0];
                    acc[1] += vec[1];
                    acc[2] += vec[2];
                } else {
                    auto &acc = reduced_upper[cv][cu];
                    acc[0] -= vec[0];
                    acc[1] -= vec[1];
                    acc[2] -= vec[2];
                }
            }
        }

        if (!materialize_skew_symmetric_csr(
                reduced_rows,
                reduced_upper,
                out.periodic_reduced_row_offsets,
                out.periodic_reduced_col_indices,
                out.periodic_reduced_dx,
                out.periodic_reduced_dy,
                out.periodic_reduced_dz,
                "CSR periodic DMI assembly",
                error)) {
            out = {};
            return false;
        }
        out.has_periodic_reduced = true;
        out.periodic_reduced_rows = reduced_rows;
    }

    return true;
#endif
}

bool gpu_dmi_csr_upload_channel(
    FemGpuLifecycleDeviceState &lifecycle,
    GpuDmiCsrChannelDeviceState &channel,
    const GpuDmiCsrHostData &host_data,
    TransferAudit &audit,
    std::string &error)
{
    if (!lifecycle.allocated) {
        return true;
    }
    if (host_data.rows == 0u) {
        error = "FemGpuState DMI CSR upload requires non-empty rows";
        return false;
    }
    const size_t expected_offsets = static_cast<size_t>(host_data.rows) + 1u;
    const size_t nnz = host_data.col_indices.size();
    if (host_data.row_offsets.size() != expected_offsets ||
        host_data.row_offsets.front() != 0u ||
        host_data.row_offsets.back() != nnz ||
        host_data.dx.size() != nnz ||
        host_data.dy.size() != nnz ||
        host_data.dz.size() != nnz) {
        error = "FemGpuState DMI CSR host data dimensions are inconsistent";
        return false;
    }
    for (uint32_t row = 0; row < host_data.rows; ++row) {
        if (host_data.row_offsets[row] > host_data.row_offsets[static_cast<size_t>(row) + 1u]) {
            error = "FemGpuState DMI CSR row offsets are not monotonic";
            return false;
        }
    }
    for (uint32_t col : host_data.col_indices) {
        if (col >= host_data.rows) {
            error = "FemGpuState DMI CSR column index is out of bounds";
            return false;
        }
    }
    if (host_data.has_periodic_reduced) {
        const uint32_t red_rows = host_data.periodic_reduced_rows;
        const size_t red_nnz = host_data.periodic_reduced_col_indices.size();
        if (red_rows == 0u || red_rows > host_data.rows ||
            host_data.periodic_reduced_row_offsets.size() != static_cast<size_t>(red_rows) + 1u ||
            host_data.periodic_reduced_row_offsets.front() != 0u ||
            host_data.periodic_reduced_row_offsets.back() != red_nnz ||
            host_data.periodic_reduced_dx.size() != red_nnz ||
            host_data.periodic_reduced_dy.size() != red_nnz ||
            host_data.periodic_reduced_dz.size() != red_nnz ||
            host_data.periodic_reduced_mass.size() != static_cast<size_t>(red_rows)) {
            error = "FemGpuState periodic DMI CSR host data dimensions are inconsistent";
            return false;
        }
        for (uint32_t row = 0; row < red_rows; ++row) {
            if (host_data.periodic_reduced_row_offsets[row] >
                host_data.periodic_reduced_row_offsets[static_cast<size_t>(row) + 1u]) {
                error = "FemGpuState periodic DMI CSR row offsets are not monotonic";
                return false;
            }
        }
        for (uint32_t col : host_data.periodic_reduced_col_indices) {
            if (col >= red_rows) {
                error = "FemGpuState periodic DMI CSR column index is out of bounds";
                return false;
            }
        }
    }

#if defined(FULLMAG_HAS_CUDA_RUNTIME) && FULLMAG_HAS_CUDA_RUNTIME
    gpu_dmi_csr_free_channel(lifecycle, channel);

    uint64_t channel_device_bytes = 0;
    if (!gpu_device_allocate_u32(
            channel.csr_row_offsets,
            static_cast<uint64_t>(host_data.row_offsets.size()),
            channel_device_bytes,
            error)) {
        gpu_dmi_csr_free_channel(lifecycle, channel);
        return false;
    }
    if (nnz > 0u) {
        if (!gpu_device_allocate_u32(
                channel.csr_col_indices, static_cast<uint64_t>(nnz), channel_device_bytes, error) ||
            !gpu_device_allocate_double(
                channel.csr_dx, static_cast<uint64_t>(nnz), channel_device_bytes, error) ||
            !gpu_device_allocate_double(
                channel.csr_dy, static_cast<uint64_t>(nnz), channel_device_bytes, error) ||
            !gpu_device_allocate_double(
                channel.csr_dz, static_cast<uint64_t>(nnz), channel_device_bytes, error)) {
            gpu_dmi_csr_free_channel(lifecycle, channel);
            return false;
        }
    }
    const uint64_t base_device_bytes = channel_device_bytes;

    const size_t red_nnz = host_data.periodic_reduced_col_indices.size();
    if (host_data.has_periodic_reduced) {
        const uint64_t red_rows = host_data.periodic_reduced_rows;
        if (!gpu_device_allocate_u32(
                channel.periodic_reduced_row_offsets,
                static_cast<uint64_t>(host_data.periodic_reduced_row_offsets.size()),
                channel_device_bytes,
                error) ||
            !gpu_device_allocate_double(
                channel.periodic_reduced_mass, red_rows, channel_device_bytes, error) ||
            !gpu_device_allocate_double(
                channel.periodic_reduced_rx, red_rows, channel_device_bytes, error) ||
            !gpu_device_allocate_double(
                channel.periodic_reduced_ry, red_rows, channel_device_bytes, error) ||
            !gpu_device_allocate_double(
                channel.periodic_reduced_rz, red_rows, channel_device_bytes, error)) {
            gpu_dmi_csr_free_channel(lifecycle, channel);
            return false;
        }
        if (red_nnz > 0u) {
            if (!gpu_device_allocate_u32(
                    channel.periodic_reduced_col_indices,
                    static_cast<uint64_t>(red_nnz),
                    channel_device_bytes,
                    error) ||
                !gpu_device_allocate_double(
                    channel.periodic_reduced_dx,
                    static_cast<uint64_t>(red_nnz),
                    channel_device_bytes,
                    error) ||
                !gpu_device_allocate_double(
                    channel.periodic_reduced_dy,
                    static_cast<uint64_t>(red_nnz),
                    channel_device_bytes,
                    error) ||
                !gpu_device_allocate_double(
                    channel.periodic_reduced_dz,
                    static_cast<uint64_t>(red_nnz),
                    channel_device_bytes,
                    error)) {
                gpu_dmi_csr_free_channel(lifecycle, channel);
                return false;
            }
        }
    }

    uint64_t copied_bytes = 0;
    const size_t row_offsets_bytes = host_data.row_offsets.size() * sizeof(uint32_t);
    if (!cuda_ok(
            cudaMemcpy(
                channel.csr_row_offsets,
                host_data.row_offsets.data(),
                row_offsets_bytes,
                cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState DMI CSR row_offsets host->device",
            error)) {
        gpu_dmi_csr_free_channel(lifecycle, channel);
        return false;
    }
    copied_bytes += static_cast<uint64_t>(row_offsets_bytes);

    if (nnz > 0u) {
        const size_t col_bytes = nnz * sizeof(uint32_t);
        const size_t val_bytes = nnz * sizeof(double);
        if (!cuda_ok(
                cudaMemcpy(
                    channel.csr_col_indices,
                    host_data.col_indices.data(),
                    col_bytes,
                    cudaMemcpyHostToDevice),
                "cudaMemcpy FemGpuState DMI CSR col_indices host->device",
                error) ||
            !cuda_ok(
                cudaMemcpy(
                    channel.csr_dx,
                    host_data.dx.data(),
                    val_bytes,
                    cudaMemcpyHostToDevice),
                "cudaMemcpy FemGpuState DMI CSR dx host->device",
                error) ||
            !cuda_ok(
                cudaMemcpy(
                    channel.csr_dy,
                    host_data.dy.data(),
                    val_bytes,
                    cudaMemcpyHostToDevice),
                "cudaMemcpy FemGpuState DMI CSR dy host->device",
                error) ||
            !cuda_ok(
                cudaMemcpy(
                    channel.csr_dz,
                    host_data.dz.data(),
                    val_bytes,
                    cudaMemcpyHostToDevice),
                "cudaMemcpy FemGpuState DMI CSR dz host->device",
                error)) {
            gpu_dmi_csr_free_channel(lifecycle, channel);
            return false;
        }
        copied_bytes += static_cast<uint64_t>(col_bytes + 3u * val_bytes);
    }

    if (host_data.has_periodic_reduced) {
        const size_t red_offsets_bytes =
            host_data.periodic_reduced_row_offsets.size() * sizeof(uint32_t);
        const size_t red_mass_bytes =
            host_data.periodic_reduced_mass.size() * sizeof(double);
        if (!cuda_ok(
                cudaMemcpy(
                    channel.periodic_reduced_row_offsets,
                    host_data.periodic_reduced_row_offsets.data(),
                    red_offsets_bytes,
                    cudaMemcpyHostToDevice),
                "cudaMemcpy FemGpuState periodic DMI CSR row_offsets host->device",
                error) ||
            !cuda_ok(
                cudaMemcpy(
                    channel.periodic_reduced_mass,
                    host_data.periodic_reduced_mass.data(),
                    red_mass_bytes,
                    cudaMemcpyHostToDevice),
                "cudaMemcpy FemGpuState periodic DMI CSR mass host->device",
                error)) {
            gpu_dmi_csr_free_channel(lifecycle, channel);
            return false;
        }
        copied_bytes += static_cast<uint64_t>(red_offsets_bytes + red_mass_bytes);

        if (red_nnz > 0u) {
            const size_t red_col_bytes = red_nnz * sizeof(uint32_t);
            const size_t red_val_bytes = red_nnz * sizeof(double);
            if (!cuda_ok(
                    cudaMemcpy(
                        channel.periodic_reduced_col_indices,
                        host_data.periodic_reduced_col_indices.data(),
                        red_col_bytes,
                        cudaMemcpyHostToDevice),
                    "cudaMemcpy FemGpuState periodic DMI CSR col_indices host->device",
                    error) ||
                !cuda_ok(
                    cudaMemcpy(
                        channel.periodic_reduced_dx,
                        host_data.periodic_reduced_dx.data(),
                        red_val_bytes,
                        cudaMemcpyHostToDevice),
                    "cudaMemcpy FemGpuState periodic DMI CSR dx host->device",
                    error) ||
                !cuda_ok(
                    cudaMemcpy(
                        channel.periodic_reduced_dy,
                        host_data.periodic_reduced_dy.data(),
                        red_val_bytes,
                        cudaMemcpyHostToDevice),
                    "cudaMemcpy FemGpuState periodic DMI CSR dy host->device",
                    error) ||
                !cuda_ok(
                    cudaMemcpy(
                        channel.periodic_reduced_dz,
                        host_data.periodic_reduced_dz.data(),
                        red_val_bytes,
                        cudaMemcpyHostToDevice),
                    "cudaMemcpy FemGpuState periodic DMI CSR dz host->device",
                    error)) {
                gpu_dmi_csr_free_channel(lifecycle, channel);
                return false;
            }
            copied_bytes += static_cast<uint64_t>(red_col_bytes + 3u * red_val_bytes);
        }
    }

    lifecycle.device_bytes += channel_device_bytes;
    channel.uploaded = true;
    channel.rows = host_data.rows;
    channel.nnz = static_cast<uint64_t>(nnz);
    channel.device_bytes = channel_device_bytes;
    channel.periodic_reduced_ready = host_data.has_periodic_reduced;
    channel.periodic_reduced_rows = host_data.has_periodic_reduced
        ? static_cast<uint64_t>(host_data.periodic_reduced_rows)
        : 0u;
    channel.periodic_reduced_nnz = host_data.has_periodic_reduced
        ? static_cast<uint64_t>(red_nnz)
        : 0u;
    channel.periodic_reduced_device_bytes = host_data.has_periodic_reduced
        ? (channel_device_bytes - base_device_bytes)
        : 0u;
    record_host_to_device(audit, copied_bytes);
    return true;
#else
    (void)channel;
    (void)audit;
    error = "FemGpuState was marked allocated but fullmag_fem was built without CUDA runtime support";
    return false;
#endif
}

void gpu_dmi_csr_free(
    FemGpuLifecycleDeviceState &lifecycle,
    FemGpuDmiCsrDeviceState &state)
{
    gpu_dmi_csr_free_channel(lifecycle, state.interfacial);
    gpu_dmi_csr_free_channel(lifecycle, state.bulk);
}

bool context_upload_mfem_dmi_to_gpu_state(
    Context &ctx,
    std::string &error)
{
    if (!ctx.gpu_state.device.lifecycle.allocated) {
        return true;
    }
    const bool need_interfacial =
        ctx.dmi.interfacial_enabled || ctx.dmi.rotated_interfacial_enabled;
    const bool need_bulk = ctx.dmi.bulk_enabled;
    if (!need_interfacial && !need_bulk) {
        return true;
    }

    if (need_interfacial) {
        GpuDmiCsrHostData host_data{};
        if (!build_gpu_dmi_csr_from_mfem(ctx, false, host_data, error) ||
            !gpu_dmi_csr_upload_channel(
                ctx.gpu_state.device.lifecycle,
                ctx.gpu_state.device.dmi_csr.interfacial,
                host_data,
                ctx.transfer_audit.audit,
                error)) {
            return false;
        }
    }
    if (need_bulk) {
        GpuDmiCsrHostData host_data{};
        if (!build_gpu_dmi_csr_from_mfem(ctx, true, host_data, error) ||
            !gpu_dmi_csr_upload_channel(
                ctx.gpu_state.device.lifecycle,
                ctx.gpu_state.device.dmi_csr.bulk,
                host_data,
                ctx.transfer_audit.audit,
                error)) {
            return false;
        }
    }
    return true;
}

} // namespace fullmag::fem

#include "context.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <limits>
#include <mutex>
#include <optional>
#include <string>
#include <tuple>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

namespace {

constexpr double kMu0 = 4.0e-7 * 3.14159265358979323846;
constexpr double kGeomEps = 1e-30;

using Vec3 = std::array<double, 3>;

std::optional<int> selected_cuda_device_from_env() {
    const char *specific = std::getenv("FULLMAG_FEM_GPU_INDEX");
    const char *generic = std::getenv("FULLMAG_CUDA_DEVICE_INDEX");
    const char *raw = specific != nullptr ? specific : generic;
    if (raw == nullptr || *raw == '\0') {
        return std::nullopt;
    }
    char *end = nullptr;
    const long parsed = std::strtol(raw, &end, 10);
    if (end == raw || *end != '\0' || parsed < 0) {
        return std::nullopt;
    }
    return static_cast<int>(parsed);
}

Vec3 add3(const Vec3 &a, const Vec3 &b) {
    return {a[0] + b[0], a[1] + b[1], a[2] + b[2]};
}

Vec3 sub3(const Vec3 &a, const Vec3 &b) {
    return {a[0] - b[0], a[1] - b[1], a[2] - b[2]};
}

Vec3 scale3(const Vec3 &a, double s) {
    return {a[0] * s, a[1] * s, a[2] * s};
}

double dot3(const Vec3 &a, const Vec3 &b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

Vec3 cross3(const Vec3 &a, const Vec3 &b) {
    return {
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    };
}

Vec3 node_coords(const Context &ctx, uint32_t node) {
    const size_t base = static_cast<size_t>(node) * 3u;
    return {
        ctx.nodes_xyz[base + 0],
        ctx.nodes_xyz[base + 1],
        ctx.nodes_xyz[base + 2],
    };
}

uint32_t transfer_axis_cells(double extent, double requested_cell) {
    if (requested_cell <= 0.0) {
        return 1;
    }
    if (extent <= 1e-18) {
        return 1;
    }
    return static_cast<uint32_t>(std::max(1.0, std::ceil(extent / requested_cell)));
}

bool magnetic_bbox(const Context &ctx, Vec3 &bbox_min, Vec3 &bbox_max) {
    if (ctx.n_nodes == 0) {
        return false;
    }
    bbox_min = {std::numeric_limits<double>::infinity(),
                std::numeric_limits<double>::infinity(),
                std::numeric_limits<double>::infinity()};
    bbox_max = {-std::numeric_limits<double>::infinity(),
                -std::numeric_limits<double>::infinity(),
                -std::numeric_limits<double>::infinity()};
    bool found_any = false;
    for (uint32_t node = 0; node < ctx.n_nodes; ++node) {
        if (!ctx.magnetic_node_mask.empty() && ctx.magnetic_node_mask[node] == 0u) {
            continue;
        }
        const Vec3 point = node_coords(ctx, node);
        for (int axis = 0; axis < 3; ++axis) {
            bbox_min[axis] = std::min(bbox_min[axis], point[axis]);
            bbox_max[axis] = std::max(bbox_max[axis], point[axis]);
        }
        found_any = true;
    }
    return found_any;
}

TransferGridDesc build_transfer_grid_desc(const Context &ctx, const Vec3 &bbox_min, const Vec3 &bbox_max) {
    const Vec3 extent = {
        std::abs(bbox_max[0] - bbox_min[0]),
        std::abs(bbox_max[1] - bbox_min[1]),
        std::abs(bbox_max[2] - bbox_min[2]),
    };
    const double requested = std::max(ctx.hmax, 1e-12);
    TransferGridDesc desc{};
    desc.nx = transfer_axis_cells(extent[0], requested);
    desc.ny = transfer_axis_cells(extent[1], requested);
    desc.nz = transfer_axis_cells(extent[2], requested);
    desc.dx = std::max(extent[0] / static_cast<double>(desc.nx), 1e-12);
    desc.dy = std::max(extent[1] / static_cast<double>(desc.ny), 1e-12);
    desc.dz = std::max(extent[2] / static_cast<double>(desc.nz), 1e-12);
    desc.bbox_min = bbox_min;
    return desc;
}

std::array<std::array<double, 3>, 3> inverse_3x3_columns(
    const std::array<Vec3, 3> &columns,
    double det)
{
    const double a = columns[0][0];
    const double b = columns[1][0];
    const double c = columns[2][0];
    const double d = columns[0][1];
    const double e = columns[1][1];
    const double f = columns[2][1];
    const double g = columns[0][2];
    const double h = columns[1][2];
    const double i = columns[2][2];
    const double inv_det = 1.0 / det;
    return {{
        {(e * i - f * h) * inv_det, (c * h - b * i) * inv_det, (b * f - c * e) * inv_det},
        {(f * g - d * i) * inv_det, (a * i - c * g) * inv_det, (c * d - a * f) * inv_det},
        {(d * h - e * g) * inv_det, (b * g - a * h) * inv_det, (a * e - b * d) * inv_det},
    }};
}

std::optional<std::array<double, 4>> barycentric_coordinates_tet(
    const Vec3 &point,
    const std::array<Vec3, 4> &vertices)
{
    const Vec3 d1 = sub3(vertices[1], vertices[0]);
    const Vec3 d2 = sub3(vertices[2], vertices[0]);
    const Vec3 d3 = sub3(vertices[3], vertices[0]);
    const Vec3 rhs = sub3(point, vertices[0]);
    const double det = dot3(d1, cross3(d2, d3));
    if (std::abs(det) <= kGeomEps) {
        return std::nullopt;
    }
    const auto inv = inverse_3x3_columns({d1, d2, d3}, det);
    const double l1 = inv[0][0] * rhs[0] + inv[0][1] * rhs[1] + inv[0][2] * rhs[2];
    const double l2 = inv[1][0] * rhs[0] + inv[1][1] * rhs[1] + inv[1][2] * rhs[2];
    const double l3 = inv[2][0] * rhs[0] + inv[2][1] * rhs[1] + inv[2][2] * rhs[2];
    const double l0 = 1.0 - l1 - l2 - l3;
    const std::array<double, 4> bary = {l0, l1, l2, l3};
    constexpr double eps = 1e-9;
    for (double value : bary) {
        if (value < -eps || value > 1.0 + eps) {
            return std::nullopt;
        }
    }
    return bary;
}

std::pair<uint32_t, uint32_t> cell_index_range_for_tet(
    double bbox_min_axis,
    double cell_size_axis,
    uint32_t n_cells_axis,
    const std::array<Vec3, 4> &vertices,
    int axis)
{
    double tet_min = std::numeric_limits<double>::infinity();
    double tet_max = -std::numeric_limits<double>::infinity();
    for (const Vec3 &vertex : vertices) {
        tet_min = std::min(tet_min, vertex[axis]);
        tet_max = std::max(tet_max, vertex[axis]);
    }
    const int64_t upper = static_cast<int64_t>(n_cells_axis) - 1;
    const int64_t start = std::clamp(
        static_cast<int64_t>(std::ceil(((tet_min - bbox_min_axis) / cell_size_axis) - 0.5)),
        int64_t{0},
        upper);
    const int64_t end = std::clamp(
        static_cast<int64_t>(std::floor(((tet_max - bbox_min_axis) / cell_size_axis) - 0.5)),
        int64_t{0},
        upper);
    return start <= end
        ? std::pair<uint32_t, uint32_t>(static_cast<uint32_t>(start), static_cast<uint32_t>(end))
        : std::pair<uint32_t, uint32_t>(static_cast<uint32_t>(end), static_cast<uint32_t>(start));
}

void rasterize_magnetization_to_transfer_grid(
    const Context &ctx,
    const std::vector<double> &magnetization_xyz,
    const TransferGridDesc &desc,
    std::vector<uint8_t> &active_mask,
    std::vector<double> &cell_magnetization_xyz)
{
    active_mask.assign(static_cast<size_t>(desc.cell_count()), 0u);
    cell_magnetization_xyz.assign(static_cast<size_t>(desc.cell_count()) * 3u, 0.0);

    for (uint32_t element_index = 0; element_index < ctx.n_elements; ++element_index) {
        if (!ctx.magnetic_element_mask.empty() &&
            ctx.magnetic_element_mask[element_index] == 0u) {
            continue;
        }
        const size_t base = static_cast<size_t>(element_index) * 4u;
        const std::array<uint32_t, 4> element = {
            ctx.elements[base + 0],
            ctx.elements[base + 1],
            ctx.elements[base + 2],
            ctx.elements[base + 3],
        };
        const std::array<Vec3, 4> vertices = {
            node_coords(ctx, element[0]),
            node_coords(ctx, element[1]),
            node_coords(ctx, element[2]),
            node_coords(ctx, element[3]),
        };
        const auto [ix0, ix1] = cell_index_range_for_tet(desc.bbox_min[0], desc.dx, desc.nx, vertices, 0);
        const auto [iy0, iy1] = cell_index_range_for_tet(desc.bbox_min[1], desc.dy, desc.ny, vertices, 1);
        const auto [iz0, iz1] = cell_index_range_for_tet(desc.bbox_min[2], desc.dz, desc.nz, vertices, 2);

        for (uint32_t iz = iz0; iz <= iz1; ++iz) {
            for (uint32_t iy = iy0; iy <= iy1; ++iy) {
                for (uint32_t ix = ix0; ix <= ix1; ++ix) {
                    const Vec3 point = {
                        desc.bbox_min[0] + (static_cast<double>(ix) + 0.5) * desc.dx,
                        desc.bbox_min[1] + (static_cast<double>(iy) + 0.5) * desc.dy,
                        desc.bbox_min[2] + (static_cast<double>(iz) + 0.5) * desc.dz,
                    };
                    const auto bary = barycentric_coordinates_tet(point, vertices);
                    if (!bary.has_value()) {
                        continue;
                    }
                    const size_t cell = desc.index(ix, iy, iz);
                    active_mask[cell] = 1u;
                    const size_t out = cell * 3u;
                    for (int component = 0; component < 3; ++component) {
                        cell_magnetization_xyz[out + component] =
                            (*bary)[0] * magnetization_xyz[static_cast<size_t>(element[0]) * 3u + component] +
                            (*bary)[1] * magnetization_xyz[static_cast<size_t>(element[1]) * 3u + component] +
                            (*bary)[2] * magnetization_xyz[static_cast<size_t>(element[2]) * 3u + component] +
                            (*bary)[3] * magnetization_xyz[static_cast<size_t>(element[3]) * 3u + component];
                    }
                }
            }
        }
    }
}

Vec3 sample_cell_centered_vector_field(
    const std::vector<double> &values_xyz,
    const TransferGridDesc &desc,
    const Vec3 &point)
{
    const auto axis_sample = [](double coord, double min_coord, double h, uint32_t n) {
        if (n <= 1) {
            return std::tuple<uint32_t, uint32_t, double>(0, 0, 0.0);
        }
        const double u = std::clamp(((coord - min_coord) / h) - 0.5, 0.0, static_cast<double>(n) - 1.0);
        const uint32_t i0 = static_cast<uint32_t>(std::floor(u));
        const uint32_t i1 = std::min<uint32_t>(i0 + 1, n - 1);
        const double t = i0 == i1 ? 0.0 : u - static_cast<double>(i0);
        return std::tuple<uint32_t, uint32_t, double>(i0, i1, t);
    };

    const auto [x0, x1, tx] = axis_sample(point[0], desc.bbox_min[0], desc.dx, desc.nx);
    const auto [y0, y1, ty] = axis_sample(point[1], desc.bbox_min[1], desc.dy, desc.ny);
    const auto [z0, z1, tz] = axis_sample(point[2], desc.bbox_min[2], desc.dz, desc.nz);

    const auto sample = [&values_xyz, &desc](uint32_t ix, uint32_t iy, uint32_t iz) {
        const size_t base = desc.index(ix, iy, iz) * 3u;
        return Vec3{values_xyz[base + 0], values_xyz[base + 1], values_xyz[base + 2]};
    };

    const auto lerp = [](const Vec3 &a, const Vec3 &b, double t) {
        return add3(scale3(a, 1.0 - t), scale3(b, t));
    };

    const Vec3 c000 = sample(x0, y0, z0);
    const Vec3 c100 = sample(x1, y0, z0);
    const Vec3 c010 = sample(x0, y1, z0);
    const Vec3 c110 = sample(x1, y1, z0);
    const Vec3 c001 = sample(x0, y0, z1);
    const Vec3 c101 = sample(x1, y0, z1);
    const Vec3 c011 = sample(x0, y1, z1);
    const Vec3 c111 = sample(x1, y1, z1);
    const Vec3 c00 = lerp(c000, c100, tx);
    const Vec3 c10 = lerp(c010, c110, tx);
    const Vec3 c01 = lerp(c001, c101, tx);
    const Vec3 c11 = lerp(c011, c111, tx);
    const Vec3 c0 = lerp(c00, c10, ty);
    const Vec3 c1 = lerp(c01, c11, ty);
    return lerp(c0, c1, tz);
}

void unpack_aos_to_components(
    const std::vector<double> &aos,
    std::vector<double> &x,
    std::vector<double> &y,
    std::vector<double> &z)
{
    const size_t n = aos.size() / 3u;
    x.resize(n);
    y.resize(n);
    z.resize(n);
    for (size_t i = 0; i < n; ++i) {
        x[i] = aos[i * 3u + 0];
        y[i] = aos[i * 3u + 1];
        z[i] = aos[i * 3u + 2];
    }
}

void unpack_aos_to_existing_components(
    const std::vector<double> &aos,
    std::vector<double> &x,
    std::vector<double> &y,
    std::vector<double> &z)
{
    const size_t n = aos.size() / 3u;
    if (x.size() != n || y.size() != n || z.size() != n) {
        unpack_aos_to_components(aos, x, y, z);
        return;
    }
    for (size_t i = 0; i < n; ++i) {
        x[i] = aos[i * 3u + 0];
        y[i] = aos[i * 3u + 1];
        z[i] = aos[i * 3u + 2];
    }
}

void pack_components_to_aos(
    const std::vector<double> &x,
    const std::vector<double> &y,
    const std::vector<double> &z,
    std::vector<double> &aos)
{
    const size_t n = x.size();
    aos.resize(n * 3u);
    for (size_t i = 0; i < n; ++i) {
        aos[i * 3u + 0] = x[i];
        aos[i * 3u + 1] = y[i];
        aos[i * 3u + 2] = z[i];
    }
}

bool is_fully_magnetic(const Context &ctx) {
    if (ctx.element_markers.empty()) {
        return true;
    }
    const uint32_t first = ctx.element_markers.front();
    return std::all_of(
        ctx.element_markers.begin(),
        ctx.element_markers.end(),
        [first](uint32_t marker) { return marker == first; });
}

void compute_row_sum_lumped_mass(const mfem::SparseMatrix &matrix, std::vector<double> &lumped) {
    const int n = matrix.Height();
    lumped.assign(static_cast<size_t>(n), 0.0);
    const int *I = matrix.GetI();
    const double *data = matrix.GetData();
    for (int row = 0; row < n; ++row) {
        double sum = 0.0;
        for (int index = I[row]; index < I[row + 1]; ++index) {
            sum += data[index];
        }
        lumped[static_cast<size_t>(row)] = sum;
    }
}

void multiply_sparse_matrix_host(
    const mfem::SparseMatrix &matrix,
    const std::vector<double> &x,
    std::vector<double> &y)
{
    const int n = matrix.Height();
    y.assign(static_cast<size_t>(n), 0.0);
    const int *I = matrix.GetI();
    const int *J = matrix.GetJ();
    const double *data = matrix.GetData();
    for (int row = 0; row < n; ++row) {
        double sum = 0.0;
        for (int index = I[row]; index < I[row + 1]; ++index) {
            sum += data[index] * x[static_cast<size_t>(J[index])];
        }
        y[static_cast<size_t>(row)] = sum;
    }
}

bool apply_exchange_component(
    const mfem::SparseMatrix &stiffness,
    const std::vector<double> &lumped_mass,
    double prefactor,
    mfem::GridFunction &m_component,
    const std::vector<double> &m_values,
    std::vector<double> &h_component,
    std::string &error)
{
    if (m_component.Size() != static_cast<int>(m_values.size())) {
        error = "MFEM GridFunction size does not match host magnetization component size";
        return false;
    }
    double *m_host = m_component.HostWrite();
    for (int i = 0; i < m_component.Size(); ++i) {
        m_host[i] = m_values[static_cast<size_t>(i)];
    }
    std::vector<double> tmp_host;
    multiply_sparse_matrix_host(stiffness, m_values, tmp_host);
    h_component.resize(m_values.size());
    for (int i = 0; i < m_component.Size(); ++i) {
        const double mass = lumped_mass[static_cast<size_t>(i)];
        if (mass <= 0.0) {
            // S08: non-magnetic nodes may have zero lumped mass when
            // assembly is restricted to magnetic elements — set h=0.
            h_component[static_cast<size_t>(i)] = 0.0;
        } else {
            h_component[static_cast<size_t>(i)] = -prefactor * tmp_host[i] / mass;
        }
    }
    return true;
}

double vector_norm3(double x, double y, double z) {
    return std::sqrt(x * x + y * y + z * z);
}

// ── S17: PI controller for adaptive time stepping ─────────────────────
// Given the local error estimate `error_norm` (0-based, 1 = at tolerance),
// computes the next dt using a PI controller:
//   dt_new = dt * safety * (1/error)^α * (prev_error/error)^β
//
// Returns the accepted/rejected status and the proposed new dt.
struct AdaptiveResult {
    bool accepted;
    double dt_next;
};

AdaptiveResult adaptive_pi_step(Context &ctx, double error_norm) {
    if (!ctx.adaptive_dt_enabled || error_norm <= 0.0) {
        return {true, ctx.dt_seconds};
    }

    const double clamped_error = std::max(error_norm, 1e-15);

    if (clamped_error <= 1.0) {
        // Accepted step — compute growth ratio
        double ratio = ctx.safety_factor *
                       std::pow(1.0 / clamped_error, ctx.pi_alpha) *
                       std::pow(ctx.prev_error_norm / clamped_error, ctx.pi_beta);
        ratio = std::min(ratio, ctx.dt_grow_max);
        ratio = std::max(ratio, 1.0);  // never shrink on accept

        const double dt_new = std::min(ctx.dt_seconds * ratio, ctx.dt_max);
        ctx.prev_error_norm = clamped_error;
        return {true, dt_new};
    } else {
        // Rejected step — shrink dt and retry
        double ratio = ctx.safety_factor *
                       std::pow(1.0 / clamped_error, ctx.pi_alpha);
        ratio = std::max(ratio, ctx.dt_shrink_min);

        const double dt_new = std::max(ctx.dt_seconds * ratio, ctx.dt_min);
        ctx.rejected_steps += 1;
        return {false, dt_new};
    }
}

void normalize_aos_field(std::vector<double> &m_xyz) {
    const size_t n = m_xyz.size() / 3u;
    for (size_t i = 0; i < n; ++i) {
        const size_t base = i * 3u;
        const double norm = vector_norm3(m_xyz[base + 0], m_xyz[base + 1], m_xyz[base + 2]);
        if (norm > 0.0) {
            m_xyz[base + 0] /= norm;
            m_xyz[base + 1] /= norm;
            m_xyz[base + 2] /= norm;
        }
    }
}

void llg_rhs_aos(
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_xyz,
    double gamma,
    double alpha,
    std::vector<double> &rhs_xyz,
    double &max_rhs)
{
    const double gamma_bar = gamma / (1.0 + alpha * alpha);
    const size_t n = m_xyz.size() / 3u;
    rhs_xyz.resize(m_xyz.size());
    max_rhs = 0.0;

    for (size_t i = 0; i < n; ++i) {
        const size_t base = i * 3u;
        const double mx = m_xyz[base + 0];
        const double my = m_xyz[base + 1];
        const double mz = m_xyz[base + 2];
        const double hx = h_xyz[base + 0];
        const double hy = h_xyz[base + 1];
        const double hz = h_xyz[base + 2];

        const double px = my * hz - mz * hy;
        const double py = mz * hx - mx * hz;
        const double pz = mx * hy - my * hx;

        const double dx = my * pz - mz * py;
        const double dy = mz * px - mx * pz;
        const double dz = mx * py - my * px;

        rhs_xyz[base + 0] = -gamma_bar * (px + alpha * dx);
        rhs_xyz[base + 1] = -gamma_bar * (py + alpha * dy);
        rhs_xyz[base + 2] = -gamma_bar * (pz + alpha * dz);

        max_rhs = std::max(
            max_rhs,
            vector_norm3(rhs_xyz[base + 0], rhs_xyz[base + 1], rhs_xyz[base + 2]));
    }
}

double max_norm_aos(const std::vector<double> &field_xyz) {
    double max_value = 0.0;
    const size_t n = field_xyz.size() / 3u;
    for (size_t i = 0; i < n; ++i) {
        const size_t base = i * 3u;
        max_value = std::max(
            max_value,
            vector_norm3(field_xyz[base + 0], field_xyz[base + 1], field_xyz[base + 2]));
    }
    return max_value;
}

void zero_non_magnetic_nodes_aos(
    std::vector<double> &field_xyz,
    const std::vector<uint8_t> &magnetic_node_mask)
{
    if (magnetic_node_mask.empty()) {
        return;
    }
    const size_t n = field_xyz.size() / 3u;
    for (size_t i = 0; i < n; ++i) {
        if (magnetic_node_mask[i] == 0u) {
            const size_t base = i * 3u;
            field_xyz[base + 0] = 0.0;
            field_xyz[base + 1] = 0.0;
            field_xyz[base + 2] = 0.0;
        }
    }
}

double external_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz)
{
    if (!ctx.has_external_field) {
        return 0.0;
    }

    double energy = 0.0;
    for (size_t i = 0; i < ctx.mfem_lumped_mass.size(); ++i) {
        const size_t base = i * 3u;
        const double mdoth =
            m_xyz[base + 0] * ctx.h_ext_xyz[base + 0] +
            m_xyz[base + 1] * ctx.h_ext_xyz[base + 1] +
            m_xyz[base + 2] * ctx.h_ext_xyz[base + 2];
        energy += -kMu0 * ctx.material.saturation_magnetisation * mdoth * ctx.mfem_lumped_mass[i];
    }
    return energy;
}

double exchange_energy_from_components(
    const mfem::SparseMatrix &stiffness,
    const std::vector<double> &mx,
    const std::vector<double> &my,
    const std::vector<double> &mz,
    double exchange_stiffness)
{
    std::vector<double> tmp;
    double energy = 0.0;
    multiply_sparse_matrix_host(stiffness, mx, tmp);
    for (size_t i = 0; i < mx.size(); ++i) {
        energy += exchange_stiffness * mx[i] * tmp[i];
    }
    multiply_sparse_matrix_host(stiffness, my, tmp);
    for (size_t i = 0; i < my.size(); ++i) {
        energy += exchange_stiffness * my[i] * tmp[i];
    }
    multiply_sparse_matrix_host(stiffness, mz, tmp);
    for (size_t i = 0; i < mz.size(); ++i) {
        energy += exchange_stiffness * mz[i] * tmp[i];
    }
    return energy;
}

bool compute_exchange_for_magnetization(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_ex_xyz,
    std::vector<double> *h_eff_xyz,
    double *exchange_energy,
    std::string &error)
{
    if (!ctx.mfem_ready) {
        error = "MFEM exchange requested before MFEM context initialization";
        return false;
    }

    auto *exchange_form = static_cast<mfem::BilinearForm *>(ctx.mfem_exchange_form);
    auto *mass_form = static_cast<mfem::BilinearForm *>(ctx.mfem_mass_form);
    auto *gf_mx = static_cast<mfem::GridFunction *>(ctx.mfem_gf_mx);
    auto *gf_my = static_cast<mfem::GridFunction *>(ctx.mfem_gf_my);
    auto *gf_mz = static_cast<mfem::GridFunction *>(ctx.mfem_gf_mz);
    if (exchange_form == nullptr || mass_form == nullptr || gf_mx == nullptr || gf_my == nullptr ||
        gf_mz == nullptr) {
        error = "MFEM exchange scaffold is missing one or more assembled objects";
        return false;
    }

    unpack_aos_to_existing_components(m_xyz, ctx.mfem_mx, ctx.mfem_my, ctx.mfem_mz);

    const auto &stiffness = exchange_form->SpMat();
    const auto &mass = mass_form->SpMat();
    if (ctx.mfem_lumped_mass.empty()) {
        compute_row_sum_lumped_mass(mass, ctx.mfem_lumped_mass);
    }

    const double prefactor = 2.0 * ctx.material.exchange_stiffness /
                             (kMu0 * ctx.material.saturation_magnetisation);

    if (!apply_exchange_component(
            stiffness,
            ctx.mfem_lumped_mass,
            prefactor,
            *gf_mx,
            ctx.mfem_mx,
            ctx.mfem_h_ex_x,
            error) ||
        !apply_exchange_component(
            stiffness,
            ctx.mfem_lumped_mass,
            prefactor,
            *gf_my,
            ctx.mfem_my,
            ctx.mfem_h_ex_y,
            error) ||
        !apply_exchange_component(
            stiffness,
            ctx.mfem_lumped_mass,
            prefactor,
            *gf_mz,
            ctx.mfem_mz,
            ctx.mfem_h_ex_z,
            error)) {
        return false;
    }

    pack_components_to_aos(ctx.mfem_h_ex_x, ctx.mfem_h_ex_y, ctx.mfem_h_ex_z, h_ex_xyz);

    // S08 multi-region: zero exchange field on non-magnetic nodes.
    // The stiffness/mass forms are already restricted to magnetic elements,
    // but nodes shared between magnetic and air may carry residual coupling.
    if (!ctx.magnetic_node_mask.empty()) {
        for (size_t i = 0; i < ctx.magnetic_node_mask.size(); ++i) {
            if (ctx.magnetic_node_mask[i] == 0u) {
                const size_t base = i * 3u;
                h_ex_xyz[base + 0] = 0.0;
                h_ex_xyz[base + 1] = 0.0;
                h_ex_xyz[base + 2] = 0.0;
            }
        }
    }

    if (h_eff_xyz != nullptr) {
        h_eff_xyz->resize(h_ex_xyz.size());
        if (ctx.has_external_field) {
            for (size_t i = 0; i < h_ex_xyz.size(); ++i) {
                (*h_eff_xyz)[i] = h_ex_xyz[i] + ctx.h_ext_xyz[i];
            }
        } else {
            *h_eff_xyz = h_ex_xyz;
        }
    }

    if (exchange_energy != nullptr) {
        *exchange_energy = exchange_energy_from_components(
            stiffness,
            ctx.mfem_mx,
            ctx.mfem_my,
            ctx.mfem_mz,
            ctx.material.exchange_stiffness);
    }

    return true;
}

bool ensure_transfer_grid_backend(
    Context &ctx,
    const std::vector<double> &magnetization_xyz,
    std::string &error)
{
    if (ctx.transfer_grid.backend != nullptr) {
        return true;
    }

    if (fullmag_fdm_is_available() != 1) {
        error =
            "native FEM transfer-grid demag requires an available Fullmag FDM backend with CUDA support";
        return false;
    }

    Vec3 bbox_min{};
    Vec3 bbox_max{};
    if (!magnetic_bbox(ctx, bbox_min, bbox_max)) {
        error = "failed to determine FEM magnetic bounding box for transfer-grid demag";
        return false;
    }

    ctx.transfer_grid.desc = build_transfer_grid_desc(ctx, bbox_min, bbox_max);
    rasterize_magnetization_to_transfer_grid(
        ctx,
        magnetization_xyz,
        ctx.transfer_grid.desc,
        ctx.transfer_grid.active_mask,
        ctx.transfer_grid.magnetization_xyz);

    const bool any_active = std::any_of(
        ctx.transfer_grid.active_mask.begin(),
        ctx.transfer_grid.active_mask.end(),
        [](uint8_t value) { return value != 0u; });
    if (!any_active) {
        error = "transfer-grid demag rasterization produced an empty active mask";
        return false;
    }

    const fullmag_fdm_plan_desc fdm_plan = {
        fullmag_fdm_grid_desc{
            ctx.transfer_grid.desc.nx,
            ctx.transfer_grid.desc.ny,
            ctx.transfer_grid.desc.nz,
            ctx.transfer_grid.desc.dx,
            ctx.transfer_grid.desc.dy,
            ctx.transfer_grid.desc.dz,
        },
        fullmag_fdm_material_desc{
            ctx.material.saturation_magnetisation,
            ctx.material.exchange_stiffness,
            ctx.material.damping,
            ctx.material.gyromagnetic_ratio,
        },
        FULLMAG_FDM_PRECISION_DOUBLE,
        FULLMAG_FDM_INTEGRATOR_HEUN,
        0,
        1,
        0,
        {0.0, 0.0, 0.0},
        ctx.transfer_grid.kernel_xx_spectrum.empty() ? nullptr : ctx.transfer_grid.kernel_xx_spectrum.data(),
        ctx.transfer_grid.kernel_yy_spectrum.empty() ? nullptr : ctx.transfer_grid.kernel_yy_spectrum.data(),
        ctx.transfer_grid.kernel_zz_spectrum.empty() ? nullptr : ctx.transfer_grid.kernel_zz_spectrum.data(),
        ctx.transfer_grid.kernel_xy_spectrum.empty() ? nullptr : ctx.transfer_grid.kernel_xy_spectrum.data(),
        ctx.transfer_grid.kernel_xz_spectrum.empty() ? nullptr : ctx.transfer_grid.kernel_xz_spectrum.data(),
        ctx.transfer_grid.kernel_yz_spectrum.empty() ? nullptr : ctx.transfer_grid.kernel_yz_spectrum.data(),
        static_cast<uint64_t>(ctx.transfer_grid.kernel_xx_spectrum.size()),
        ctx.transfer_grid.active_mask.data(),
        static_cast<uint64_t>(ctx.transfer_grid.active_mask.size()),
        nullptr,  // region_mask — not used for FEM transfer grid
        0,        // region_mask_len
        ctx.transfer_grid.magnetization_xyz.data(),
        static_cast<uint64_t>(ctx.transfer_grid.magnetization_xyz.size()),
    };

    ctx.transfer_grid.backend = fullmag_fdm_backend_create(&fdm_plan);
    if (ctx.transfer_grid.backend == nullptr) {
        error = "fullmag_fdm_backend_create returned null during FEM transfer-grid demag setup";
        return false;
    }

    if (const char *fdm_error = fullmag_fdm_backend_last_error(ctx.transfer_grid.backend)) {
        error = std::string("FEM transfer-grid demag failed to initialize FDM backend: ") + fdm_error;
        fullmag_fdm_backend_destroy(ctx.transfer_grid.backend);
        ctx.transfer_grid.backend = nullptr;
        return false;
    }

    ctx.transfer_grid.ready = true;
    ctx.transfer_grid.demag_xyz.assign(ctx.transfer_grid.magnetization_xyz.size(), 0.0);
    return true;
}

bool compute_demag_for_magnetization(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_demag_xyz,
    double &demag_energy,
    std::string &error)
{
    if (ctx.mfem_lumped_mass.empty()) {
        auto *mass_form = static_cast<mfem::BilinearForm *>(ctx.mfem_mass_form);
        if (mass_form == nullptr) {
            error = "MFEM mass form is unavailable for transfer-grid demag energy evaluation";
            return false;
        }
        compute_row_sum_lumped_mass(mass_form->SpMat(), ctx.mfem_lumped_mass);
    }

    if (!ensure_transfer_grid_backend(ctx, m_xyz, error)) {
        return false;
    }

    rasterize_magnetization_to_transfer_grid(
        ctx,
        m_xyz,
        ctx.transfer_grid.desc,
        ctx.transfer_grid.active_mask,
        ctx.transfer_grid.magnetization_xyz);

    if (fullmag_fdm_backend_upload_magnetization_f64(
            ctx.transfer_grid.backend,
            ctx.transfer_grid.magnetization_xyz.data(),
            static_cast<uint64_t>(ctx.transfer_grid.magnetization_xyz.size())) != FULLMAG_FDM_OK)
    {
        const char *fdm_error = fullmag_fdm_backend_last_error(ctx.transfer_grid.backend);
        error = std::string("FEM transfer-grid demag failed to upload magnetization: ") +
                (fdm_error != nullptr ? fdm_error : "unknown FDM error");
        return false;
    }

    if (fullmag_fdm_backend_refresh_observables(ctx.transfer_grid.backend) != FULLMAG_FDM_OK) {
        const char *fdm_error = fullmag_fdm_backend_last_error(ctx.transfer_grid.backend);
        error = std::string("FEM transfer-grid demag failed to refresh FDM observables: ") +
                (fdm_error != nullptr ? fdm_error : "unknown FDM error");
        return false;
    }

    if (fullmag_fdm_backend_copy_field_f64(
            ctx.transfer_grid.backend,
            FULLMAG_FDM_OBSERVABLE_H_DEMAG,
            ctx.transfer_grid.demag_xyz.data(),
            static_cast<uint64_t>(ctx.transfer_grid.demag_xyz.size())) != FULLMAG_FDM_OK)
    {
        const char *fdm_error = fullmag_fdm_backend_last_error(ctx.transfer_grid.backend);
        error = std::string("FEM transfer-grid demag failed to copy H_demag: ") +
                (fdm_error != nullptr ? fdm_error : "unknown FDM error");
        return false;
    }

    h_demag_xyz.assign(static_cast<size_t>(ctx.n_nodes) * 3u, 0.0);
    for (uint32_t node = 0; node < ctx.n_nodes; ++node) {
        if (!ctx.magnetic_node_mask.empty() && ctx.magnetic_node_mask[node] == 0u) {
            continue;
        }
        const Vec3 sampled = sample_cell_centered_vector_field(
            ctx.transfer_grid.demag_xyz,
            ctx.transfer_grid.desc,
            node_coords(ctx, node));
        const size_t base = static_cast<size_t>(node) * 3u;
        h_demag_xyz[base + 0] = sampled[0];
        h_demag_xyz[base + 1] = sampled[1];
        h_demag_xyz[base + 2] = sampled[2];
    }

    demag_energy = 0.0;
    for (size_t node = 0; node < ctx.mfem_lumped_mass.size(); ++node) {
        const size_t base = node * 3u;
        const double mdoth =
            m_xyz[base + 0] * h_demag_xyz[base + 0] +
            m_xyz[base + 1] * h_demag_xyz[base + 1] +
            m_xyz[base + 2] * h_demag_xyz[base + 2];
        demag_energy +=
            -0.5 * kMu0 * ctx.material.saturation_magnetisation * mdoth * ctx.mfem_lumped_mass[node];
    }

    return true;
}

bool compute_effective_fields_for_magnetization(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_ex_xyz,
    std::vector<double> &h_demag_xyz,
    std::vector<double> &h_eff_xyz,
    double *exchange_energy,
    double *demag_energy,
    std::string &error)
{
    h_ex_xyz.assign(m_xyz.size(), 0.0);
    h_demag_xyz.assign(m_xyz.size(), 0.0);
    h_eff_xyz.assign(m_xyz.size(), 0.0);

    double exchange = 0.0;
    if (ctx.enable_exchange) {
        if (!compute_exchange_for_magnetization(
                ctx, m_xyz, h_ex_xyz, nullptr, exchange_energy != nullptr ? &exchange : nullptr, error))
        {
            return false;
        }
    }

    double demag = 0.0;
    if (ctx.enable_demag) {
        if (ctx.demag_realization == 1 /* POISSON_AIRBOX */ && ctx.poisson_ready) {
            if (!context_compute_demag_poisson(ctx, m_xyz, h_demag_xyz, demag, error)) {
                return false;
            }
        } else {
            if (!compute_demag_for_magnetization(
                    ctx, m_xyz, h_demag_xyz, demag, error))
            {
                return false;
            }
        }
    }

    for (size_t i = 0; i < h_eff_xyz.size(); ++i) {
        h_eff_xyz[i] = h_ex_xyz[i] + h_demag_xyz[i] + ctx.h_ext_xyz[i];
    }

    if (exchange_energy != nullptr) {
        *exchange_energy = exchange;
    }
    if (demag_energy != nullptr) {
        *demag_energy = demag;
    }

    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Poisson demag: ∇²u = ∇·M on Ω_m ∪ Ω_air  (S02–S05)
// ─────────────────────────────────────────────────────────────────────────────

/// Custom MFEM VectorCoefficient for M_s * m(x), restricted to magnetic elements.
/// Returns zero on air elements. Used for the Poisson RHS: b(v) = ∫ M·∇v dV.
class MagnetizationCoefficient : public mfem::VectorCoefficient {
public:
    MagnetizationCoefficient(
        const Context &ctx_ref,
        const std::vector<double> &m_xyz_ref,
        mfem::FiniteElementSpace *fes_ref)
        : mfem::VectorCoefficient(3)
        , ctx_(ctx_ref)
        , m_xyz_(m_xyz_ref)
        , fes_(fes_ref)
    {
    }

    void Eval(mfem::Vector &V, mfem::ElementTransformation &T,
              const mfem::IntegrationPoint &ip) override
    {
        V.SetSize(3);

        // Check if this element is magnetic
        const int elem_no = T.ElementNo;
        if (elem_no >= 0 &&
            !ctx_.magnetic_element_mask.empty() &&
            static_cast<size_t>(elem_no) < ctx_.magnetic_element_mask.size() &&
            ctx_.magnetic_element_mask[static_cast<size_t>(elem_no)] == 0u) {
            V = 0.0;
            return;
        }

        // Interpolate m at the integration point using FE basis
        mfem::Array<int> dofs;
        fes_->GetElementDofs(elem_no, dofs);
        const int ndof = dofs.Size();

        // Evaluate shape functions at ip
        const mfem::FiniteElement *fe = fes_->GetFE(elem_no);
        mfem::Vector shape(ndof);
        fe->CalcShape(ip, shape);

        // Interpolate m components
        double mx = 0.0, my = 0.0, mz = 0.0;
        for (int i = 0; i < ndof; ++i) {
            const int global_dof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
            const double sign = dofs[i] >= 0 ? 1.0 : -1.0;
            const size_t base = static_cast<size_t>(global_dof) * 3u;
            mx += sign * shape(i) * m_xyz_[base + 0];
            my += sign * shape(i) * m_xyz_[base + 1];
            mz += sign * shape(i) * m_xyz_[base + 2];
        }

        // M = M_s * m (A/m)
        const double Ms = ctx_.material.saturation_magnetisation;
        V(0) = Ms * mx;
        V(1) = Ms * my;
        V(2) = Ms * mz;
    }

private:
    const Context &ctx_;
    const std::vector<double> &m_xyz_;
    mfem::FiniteElementSpace *fes_;
};

/// Assemble the Poisson RHS: b(v) = ∫_Ω_m M·∇v dV
bool assemble_poisson_rhs(
    Context &ctx,
    const std::vector<double> &m_xyz,
    mfem::Vector &rhs,
    std::string &error)
{
    auto *fes = static_cast<mfem::FiniteElementSpace *>(ctx.mfem_potential_fes);
    if (fes == nullptr) {
        error = "Poisson FE space is null during RHS assembly";
        return false;
    }

    MagnetizationCoefficient M_coeff(ctx, m_xyz, fes);

    mfem::LinearForm b(fes);
    b.AddDomainIntegrator(new mfem::DomainLFGradIntegrator(M_coeff));
    b.Assemble();

    rhs.SetSize(fes->GetTrueVSize());
    if (const mfem::SparseMatrix *restriction = fes->GetRestrictionMatrix()) {
        restriction->Mult(b, rhs);
    } else {
        rhs = b;
    }

    return true;
}

/// Solve the Poisson equation: -∇²u = -∇·M with Dirichlet u=0 on ∂D.
bool solve_poisson(
    Context &ctx,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    std::string &error)
{
    auto *A_bc = static_cast<mfem::SparseMatrix *>(ctx.mfem_poisson_bc_op);
    if (A_bc == nullptr) {
        error = "Poisson BC-eliminated operator is null during solve";
        return false;
    }

    // Apply boundary conditions to RHS only (matrix is pre-eliminated in init)
    mfem::Vector rhs_bc(rhs);
    mfem::Array<int> ess_tdof(ctx.poisson_ess_tdof_list.data(),
                              static_cast<int>(ctx.poisson_ess_tdof_list.size()));
    for (int i = 0; i < ess_tdof.Size(); ++i) {
        rhs_bc(ess_tdof[i]) = 0.0;
    }

    // Warm-start from previous step
    mfem::Vector sol_bc(solution);

    // CG solver with diagonal (Jacobi) preconditioner
    mfem::DSmoother prec;
    mfem::CGSolver cg;
    cg.SetRelTol(ctx.demag_solver.relative_tolerance);
    cg.SetMaxIter(static_cast<int>(ctx.demag_solver.max_iterations));
    cg.SetPrintLevel(0);
    cg.SetOperator(*A_bc);
    cg.SetPreconditioner(prec);

    cg.Mult(rhs_bc, sol_bc);

    ctx.poisson_last_iterations = cg.GetNumIterations();
    ctx.poisson_last_residual = cg.GetFinalNorm();

    // Restore essential DOF values (u=0 on boundary)
    for (int i = 0; i < ess_tdof.Size(); ++i) {
        sol_bc(ess_tdof[i]) = 0.0;
    }

    solution = sol_bc;
    return true;
}

#ifdef MFEM_USE_MPI
// ── S10: Hypre GPU CG + BoomerAMG for Poisson ─────────────────────────
// Wraps the pre-eliminated SparseMatrix in a HypreParMatrix and solves
// with HyprePCG + HypreBoomerAMG.  MPI is initialized in serial mode
// (single process) solely to satisfy Hypre's interface requirements.

void ensure_mpi_initialized() {
    int initialized = 0;
    MPI_Initialized(&initialized);
    if (!initialized) {
        int provided = 0;
        MPI_Init_thread(nullptr, nullptr, MPI_THREAD_FUNNELED, &provided);
    }
}

bool solve_poisson_hypre(
    Context &ctx,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    std::string &error)
{
    auto *A_bc = static_cast<mfem::SparseMatrix *>(ctx.mfem_poisson_bc_op);
    if (A_bc == nullptr) {
        error = "Poisson BC-eliminated operator is null during Hypre solve";
        return false;
    }

    ensure_mpi_initialized();

    // Apply BCs to RHS
    mfem::Vector rhs_bc(rhs);
    mfem::Array<int> ess_tdof(ctx.poisson_ess_tdof_list.data(),
                              static_cast<int>(ctx.poisson_ess_tdof_list.size()));
    for (int i = 0; i < ess_tdof.Size(); ++i) {
        rhs_bc(ess_tdof[i]) = 0.0;
    }

    const HYPRE_BigInt glob_size = static_cast<HYPRE_BigInt>(A_bc->NumRows());
    HYPRE_BigInt row_starts[2] = {0, glob_size};

    // First call: build and cache the HypreParMatrix + AMG + PCG
    if (!ctx.poisson_solver_setup) {
        // Wrap the SparseMatrix in a HypreParMatrix (borrows pointers; lives as long as ctx)
        auto *A_par = new mfem::HypreParMatrix(MPI_COMM_WORLD, glob_size, row_starts, A_bc);
        ctx.mfem_cached_hypre_par = A_par;

        // BoomerAMG preconditioner — GPU-friendly settings
        auto *amg = new mfem::HypreBoomerAMG(*A_par);
        amg->SetPrintLevel(0);
        amg->SetRelaxType(18);   // l1-scaled Jacobi (GPU-friendly)
        amg->SetCoarsenType(8);  // PMIS (good for GPU/parallel)
        amg->SetInterpType(6);   // extended+i interpolation
        amg->SetAggressiveCoarseningLevels(1);
        ctx.mfem_cached_hypre_amg = amg;

        // HyprePCG solver
        auto *pcg = new mfem::HyprePCG(MPI_COMM_WORLD);
        pcg->SetTol(ctx.demag_solver.relative_tolerance);
        pcg->SetMaxIter(static_cast<int>(ctx.demag_solver.max_iterations));
        pcg->SetPrintLevel(0);
        pcg->SetOperator(*A_par);
        pcg->SetPreconditioner(*amg);
        ctx.mfem_cached_hypre_pcg = pcg;

        ctx.poisson_solver_setup = true;
    }

    auto *A_par = static_cast<mfem::HypreParMatrix *>(ctx.mfem_cached_hypre_par);
    auto *pcg = static_cast<mfem::HyprePCG *>(ctx.mfem_cached_hypre_pcg);

    // Wrap host vectors as HypreParVectors
    mfem::HypreParVector b_par(MPI_COMM_WORLD, glob_size, rhs_bc.GetData(), row_starts);
    mfem::HypreParVector x_par(MPI_COMM_WORLD, glob_size, solution.GetData(), row_starts);

    pcg->Mult(b_par, x_par);

    // x_par writes directly into solution.GetData()
    ctx.poisson_last_iterations = pcg->GetNumIterations();
    ctx.poisson_last_residual = pcg->GetFinalNorm();

    // Restore essential DOFs
    for (int i = 0; i < ess_tdof.Size(); ++i) {
        solution(ess_tdof[i]) = 0.0;
    }

    return true;
}
#endif // MFEM_USE_MPI

/// Recover H_demag = -∇u from the scalar potential solution.
/// Computes element-wise gradient, distributes to nodes weighted by shape functions.
bool recover_demag_field(
    Context &ctx,
    const mfem::Vector &potential,
    std::vector<double> &h_demag_xyz,
    double &demag_energy,
    const std::vector<double> &m_xyz,
    std::string &error)
{
    auto *fes = static_cast<mfem::FiniteElementSpace *>(ctx.mfem_potential_fes);
    auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_mesh);
    if (fes == nullptr || mesh == nullptr) {
        error = "Poisson FE space or mesh is null during H_demag recovery";
        return false;
    }

    h_demag_xyz.assign(static_cast<size_t>(ctx.n_nodes) * 3u, 0.0);

    // Create GridFunction from the potential solution
    mfem::GridFunction gf_u(fes);
    gf_u.SetFromTrueDofs(potential);

    // Accumulate -∇u at each node, weighted by shape * quadrature weight
    std::vector<double> node_weight(static_cast<size_t>(ctx.n_nodes), 0.0);

    for (int elem = 0; elem < mesh->GetNE(); ++elem) {
        const mfem::FiniteElement *fe = fes->GetFE(elem);
        mfem::ElementTransformation *T = mesh->GetElementTransformation(elem);

        mfem::Array<int> dofs;
        fes->GetElementDofs(elem, dofs);
        const int local_ndof = dofs.Size();

        // Extract element DOF values of the potential
        mfem::Vector u_elem(local_ndof);
        for (int i = 0; i < local_ndof; ++i) {
            const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
            const double sign = dofs[i] >= 0 ? 1.0 : -1.0;
            u_elem(i) = sign * gf_u(gdof);
        }

        const mfem::IntegrationRule &ir =
            mfem::IntRules.Get(fe->GetGeomType(), 2 * fe->GetOrder());

        for (int q = 0; q < ir.GetNPoints(); ++q) {
            const mfem::IntegrationPoint &ip = ir.IntPoint(q);
            T->SetIntPoint(&ip);
            const double w = ip.weight * T->Weight();

            // Gradient of shape functions in physical coordinates
            mfem::DenseMatrix dshape(local_ndof, 3);
            fe->CalcPhysDShape(*T, dshape);

            // grad_u = Σᵢ uᵢ · ∇φᵢ
            double grad_u[3] = {0.0, 0.0, 0.0};
            for (int i = 0; i < local_ndof; ++i) {
                for (int d = 0; d < 3; ++d) {
                    grad_u[d] += u_elem(i) * dshape(i, d);
                }
            }

            // Distribute -∇u to each DOF, weighted by shape function
            mfem::Vector shape(local_ndof);
            fe->CalcShape(ip, shape);
            for (int i = 0; i < local_ndof; ++i) {
                const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
                if (gdof < 0 || static_cast<uint32_t>(gdof) >= ctx.n_nodes) {
                    continue;
                }
                const double phi_w = std::abs(shape(i)) * w;
                const size_t base = static_cast<size_t>(gdof) * 3u;
                h_demag_xyz[base + 0] += -grad_u[0] * phi_w;
                h_demag_xyz[base + 1] += -grad_u[1] * phi_w;
                h_demag_xyz[base + 2] += -grad_u[2] * phi_w;
                node_weight[static_cast<size_t>(gdof)] += phi_w;
            }
        }
    }

    // Normalize by accumulated weights
    for (uint32_t node = 0; node < ctx.n_nodes; ++node) {
        if (node_weight[node] > 0.0) {
            const size_t base = static_cast<size_t>(node) * 3u;
            h_demag_xyz[base + 0] /= node_weight[node];
            h_demag_xyz[base + 1] /= node_weight[node];
            h_demag_xyz[base + 2] /= node_weight[node];
        }
    }

    // Zero out non-magnetic nodes
    zero_non_magnetic_nodes_aos(h_demag_xyz, ctx.magnetic_node_mask);

    // Demag energy: E_d = -μ₀/2 · M_s · Σᵢ (m·h_d)ᵢ · M_Lᵢ
    if (ctx.mfem_lumped_mass.empty()) {
        auto *mass_form = static_cast<mfem::BilinearForm *>(ctx.mfem_mass_form);
        if (mass_form != nullptr) {
            compute_row_sum_lumped_mass(mass_form->SpMat(), ctx.mfem_lumped_mass);
        }
    }

    demag_energy = 0.0;
    for (size_t i = 0; i < ctx.mfem_lumped_mass.size(); ++i) {
        if (!ctx.magnetic_node_mask.empty() && ctx.magnetic_node_mask[i] == 0u) {
            continue;
        }
        const size_t base = i * 3u;
        const double mdoth =
            m_xyz[base + 0] * h_demag_xyz[base + 0] +
            m_xyz[base + 1] * h_demag_xyz[base + 1] +
            m_xyz[base + 2] * h_demag_xyz[base + 2];
        demag_energy +=
            -0.5 * kMu0 * ctx.material.saturation_magnetisation *
            mdoth * ctx.mfem_lumped_mass[i];
    }

    return true;
}

} // namespace

bool context_initialize_mfem(Context &ctx, std::string &error) {
    try {
        // mfem::Device is a process-global singleton; creating it more than once
        // triggers an abort ("mfem::Device is already configured!").  We use
        // std::call_once so that multi-stage simulations AND parallel test
        // threads share the same device safely.
        static std::once_flag s_mfem_device_once;
#if FULLMAG_HAS_CUDA_RUNTIME
        const int selected_device = selected_cuda_device_from_env().value_or(0);
        int device_count = 0;
        cudaError_t cuda_err = cudaGetDeviceCount(&device_count);
        if (cuda_err != cudaSuccess || device_count <= 0) {
            error = "MFEM CUDA backend requested but no CUDA device is available";
            return false;
        }
        if (selected_device < 0 || selected_device >= device_count) {
            error = "requested FEM GPU device index is out of range";
            return false;
        }
        cuda_err = cudaSetDevice(selected_device);
        if (cuda_err != cudaSuccess) {
            error = std::string("cudaSetDevice failed for native FEM backend: ") +
                    cudaGetErrorString(cuda_err);
            return false;
        }
        std::call_once(s_mfem_device_once, [&ctx]() {
            ctx.mfem_device = new mfem::Device("cuda");
        });
        ctx.mfem_selected_device_index = selected_device;

        // S12: Create prioritized CUDA streams
        {
            int low_priority = 0, high_priority = 0;
            cudaDeviceGetStreamPriorityRange(&low_priority, &high_priority);
            cudaStream_t cs{}, ios{};
            cudaStreamCreateWithPriority(&cs, cudaStreamNonBlocking, high_priority);
            cudaStreamCreateWithPriority(&ios, cudaStreamNonBlocking, low_priority);
            ctx.compute_stream = reinterpret_cast<void *>(cs);
            ctx.io_stream = reinterpret_cast<void *>(ios);
            cudaEvent_t ev{};
            cudaEventCreateWithFlags(&ev, cudaEventDisableTiming);
            ctx.compute_event = reinterpret_cast<void *>(ev);
        }
#else
        std::call_once(s_mfem_device_once, [&ctx]() {
            ctx.mfem_device = new mfem::Device("cpu");
        });
        ctx.mfem_selected_device_index = -1;
#endif

        auto *mesh = new mfem::Mesh(3, static_cast<int>(ctx.n_nodes), static_cast<int>(ctx.n_elements),
                                    static_cast<int>(ctx.n_boundary_faces), 3);

        for (uint32_t i = 0; i < ctx.n_nodes; ++i) {
            const double *coords = ctx.nodes_xyz.data() + static_cast<size_t>(i) * 3u;
            mesh->AddVertex(coords);
        }

        for (uint32_t i = 0; i < ctx.n_elements; ++i) {
            const int *ignored = nullptr;
            (void)ignored;
            const uint32_t *tet = ctx.elements.data() + static_cast<size_t>(i) * 4u;
            const int vi[4] = {
                static_cast<int>(tet[0]),
                static_cast<int>(tet[1]),
                static_cast<int>(tet[2]),
                static_cast<int>(tet[3]),
            };
            // MFEM attributes must be >= 1.  Our markers: 1 = magnetic, 0 = air.
            // Map: marker 0 -> attr 2 (air), marker 1 -> attr 1 (magnetic).
            // Any other marker m -> attr m (unchanged, already >= 1).
            int attr = 1;
            if (!ctx.element_markers.empty()) {
                const uint32_t marker = ctx.element_markers[static_cast<size_t>(i)];
                attr = marker == 0u ? 2 : static_cast<int>(marker);
            }
            mesh->AddTet(vi, attr);
        }

        for (uint32_t i = 0; i < ctx.n_boundary_faces; ++i) {
            const uint32_t *tri = ctx.boundary_faces.data() + static_cast<size_t>(i) * 3u;
            const int vi[3] = {
                static_cast<int>(tri[0]),
                static_cast<int>(tri[1]),
                static_cast<int>(tri[2]),
            };
            const int attr = ctx.boundary_markers.empty()
                ? 1
                : static_cast<int>(ctx.boundary_markers[static_cast<size_t>(i)]);
            mesh->AddBdrTriangle(vi, attr);
        }

        mesh->FinalizeTopology();
        mesh->Finalize(false, true);

        auto *fec = new mfem::H1_FECollection(static_cast<int>(ctx.fe_order), mesh->Dimension());
        auto *fes = new mfem::FiniteElementSpace(mesh, fec);

        if (fes->GetNDofs() != static_cast<int>(ctx.n_nodes)) {
            error = "MFEM H1 P1 space DOF count does not match node count";
            delete fes;
            delete fec;
            delete mesh;
            return false;
        }

        unpack_aos_to_components(ctx.m_xyz, ctx.mfem_mx, ctx.mfem_my, ctx.mfem_mz);
        auto *gf_mx = new mfem::GridFunction(fes);
        auto *gf_my = new mfem::GridFunction(fes);
        auto *gf_mz = new mfem::GridFunction(fes);
        // S09: enable device memory so that future GPU operators find data
        // already on device without extra H2D copies.
        gf_mx->UseDevice(true);
        gf_my->UseDevice(true);
        gf_mz->UseDevice(true);
        double *mx_host = gf_mx->HostWrite();
        double *my_host = gf_my->HostWrite();
        double *mz_host = gf_mz->HostWrite();
        for (int i = 0; i < fes->GetNDofs(); ++i) {
            mx_host[i] = ctx.mfem_mx[static_cast<size_t>(i)];
            my_host[i] = ctx.mfem_my[static_cast<size_t>(i)];
            mz_host[i] = ctx.mfem_mz[static_cast<size_t>(i)];
        }

        auto *exchange_form = new mfem::BilinearForm(fes);
        auto *mass_form = new mfem::BilinearForm(fes);

        // S08 multi-region: restrict exchange/mass assembly to magnetic
        // elements only (MFEM attribute 1).  For single-material meshes the
        // max attribute is 1, so every element is included.
        const int max_attr = mesh->attributes.Max();
        mfem::Array<int> magnetic_attr_marker(max_attr);
        magnetic_attr_marker = 0;
        // Attribute 1 = magnetic elements
        magnetic_attr_marker[0] = 1;

        exchange_form->AddDomainIntegrator(
            new mfem::DiffusionIntegrator(), magnetic_attr_marker);
        exchange_form->Assemble();
        exchange_form->Finalize();

        mass_form->AddDomainIntegrator(
            new mfem::MassIntegrator(), magnetic_attr_marker);
        mass_form->Assemble();
        mass_form->Finalize();

        ctx.mfem_mesh = mesh;
        ctx.mfem_fec = fec;
        ctx.mfem_fes = fes;
        ctx.mfem_gf_mx = gf_mx;
        ctx.mfem_gf_my = gf_my;
        ctx.mfem_gf_mz = gf_mz;
        ctx.mfem_exchange_form = exchange_form;
        ctx.mfem_mass_form = mass_form;
        ctx.mfem_ready = true;
        return true;
    } catch (const std::exception &ex) {
        error = std::string("MFEM mesh/space initialization failed: ") + ex.what();
    } catch (...) {
        error = "MFEM mesh/space initialization failed with an unknown error";
    }

    context_destroy_mfem(ctx);
    return false;
}

void context_destroy_mfem(Context &ctx) {
    // Destroy Poisson demag resources first
    context_destroy_poisson(ctx);

    if (ctx.transfer_grid.backend != nullptr) {
        fullmag_fdm_backend_destroy(ctx.transfer_grid.backend);
        ctx.transfer_grid.backend = nullptr;
    }
    ctx.transfer_grid.ready = false;
    ctx.transfer_grid.active_mask.clear();
    ctx.transfer_grid.magnetization_xyz.clear();
    ctx.transfer_grid.demag_xyz.clear();
    ctx.transfer_grid.kernel_xx_spectrum.clear();
    ctx.transfer_grid.kernel_yy_spectrum.clear();
    ctx.transfer_grid.kernel_zz_spectrum.clear();
    ctx.transfer_grid.kernel_xy_spectrum.clear();
    ctx.transfer_grid.kernel_xz_spectrum.clear();
    ctx.transfer_grid.kernel_yz_spectrum.clear();
    // NOTE: mfem::Device is a process-global singleton — do NOT delete it here,
    // because a subsequent NativeFemBackend may need the already-configured device.
    delete static_cast<mfem::BilinearForm *>(ctx.mfem_mass_form);
    delete static_cast<mfem::BilinearForm *>(ctx.mfem_exchange_form);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_gf_mz);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_gf_my);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_gf_mx);
    delete static_cast<mfem::FiniteElementSpace *>(ctx.mfem_fes);
    delete static_cast<mfem::FiniteElementCollection *>(ctx.mfem_fec);
    delete static_cast<mfem::Mesh *>(ctx.mfem_mesh);
    ctx.mfem_device = nullptr;
    ctx.mfem_mass_form = nullptr;
    ctx.mfem_exchange_form = nullptr;
    ctx.mfem_gf_mz = nullptr;
    ctx.mfem_gf_my = nullptr;
    ctx.mfem_gf_mx = nullptr;
    ctx.mfem_fes = nullptr;
    ctx.mfem_fec = nullptr;
    ctx.mfem_mesh = nullptr;
    ctx.mfem_ready = false;
    ctx.mfem_exchange_ready = false;

    // S12: Destroy CUDA streams and events
#if FULLMAG_HAS_CUDA_RUNTIME
    if (ctx.compute_stream != nullptr) {
        cudaStreamDestroy(reinterpret_cast<cudaStream_t>(ctx.compute_stream));
        ctx.compute_stream = nullptr;
    }
    if (ctx.io_stream != nullptr) {
        cudaStreamDestroy(reinterpret_cast<cudaStream_t>(ctx.io_stream));
        ctx.io_stream = nullptr;
    }
    if (ctx.compute_event != nullptr) {
        cudaEventDestroy(reinterpret_cast<cudaEvent_t>(ctx.compute_event));
        ctx.compute_event = nullptr;
    }
    // S13: Free pinned snapshot buffers
    for (auto &buf : ctx.pinned_snapshot) {
        if (buf != nullptr) {
            cudaFreeHost(buf);
            buf = nullptr;
        }
    }
    ctx.pinned_snapshot_bytes = 0;
#endif
}

// ─────────────────────────────────────────────────────────────────────────────
// Poisson demag initialization / destruction / compute (S02–S05)
// ─────────────────────────────────────────────────────────────────────────────

bool context_initialize_poisson(Context &ctx, std::string &error) {
    try {
        auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_mesh);
        if (mesh == nullptr) {
            error = "MFEM mesh is null — cannot initialize Poisson demag";
            return false;
        }

        // S02: Scalar H1 FE space on the FULL mesh (magnetic + air)
        auto *potential_fec = new mfem::H1_FECollection(
            static_cast<int>(ctx.fe_order), mesh->Dimension());
        auto *potential_fes = new mfem::FiniteElementSpace(mesh, potential_fec);

        // S02: Poisson bilinear form: a(u,v) = ∫ ∇u·∇v dV (Laplacian)
        auto *poisson_bilinear = new mfem::BilinearForm(potential_fes);
        poisson_bilinear->AddDomainIntegrator(new mfem::DiffusionIntegrator());
        poisson_bilinear->Assemble();
        poisson_bilinear->Finalize();

        // Identify essential DOFs: Dirichlet u=0 on outer boundary
        // The boundary marker value corresponds to the air-box outer surface
        ctx.poisson_ess_tdof_list.clear();
        if (ctx.poisson_boundary_marker > 0) {
            // Build attribute list from mesh boundary attributes
            mfem::Array<int> bdr_attr_is_ess(mesh->bdr_attributes.Max());
            bdr_attr_is_ess = 0;
            // Mark the outer boundary marker as essential
            if (ctx.poisson_boundary_marker <= mesh->bdr_attributes.Max()) {
                bdr_attr_is_ess[ctx.poisson_boundary_marker - 1] = 1;
            }
            mfem::Array<int> ess_tdof;
            potential_fes->GetEssentialTrueDofs(bdr_attr_is_ess, ess_tdof);
            ctx.poisson_ess_tdof_list.assign(
                ess_tdof.GetData(),
                ess_tdof.GetData() + ess_tdof.Size());
        }

        // If no essential DOFs were found (e.g., no outer boundary marker),
        // pin the first DOF to remove the constant null space
        if (ctx.poisson_ess_tdof_list.empty()) {
            ctx.poisson_ess_tdof_list.push_back(0);
        }

        // Potential GridFunction (warm-start: zeros initially)
        auto *gf_potential = new mfem::GridFunction(potential_fes);
        gf_potential->UseDevice(true);
        *gf_potential = 0.0;

        ctx.mfem_potential_fec = potential_fec;
        ctx.mfem_potential_fes = potential_fes;
        ctx.mfem_poisson_bilinear = poisson_bilinear;
        ctx.mfem_gf_potential = gf_potential;
        ctx.poisson_ready = true;

        // S09: Pre-compute the BC-eliminated Poisson operator once.
        // This avoids the per-step SparseMatrix copy in solve_poisson.
        {
            mfem::Array<int> ess_tdof(
                ctx.poisson_ess_tdof_list.data(),
                static_cast<int>(ctx.poisson_ess_tdof_list.size()));

            auto *A_bc = new mfem::SparseMatrix(poisson_bilinear->SpMat());
            for (int i = 0; i < ess_tdof.Size(); ++i) {
                A_bc->EliminateRowCol(ess_tdof[i]);
            }
            ctx.mfem_poisson_bc_op = A_bc;
        }

        return true;
    } catch (const std::exception &ex) {
        error = std::string("Poisson demag initialization failed: ") + ex.what();
    } catch (...) {
        error = "Poisson demag initialization failed with an unknown error";
    }
    context_destroy_poisson(ctx);
    return false;
}

void context_destroy_poisson(Context &ctx) {
    // Cached Hypre solver objects — must be deleted before the matrix they reference.
    // Order matters: PCG → AMG → ParMatrix (reverse of construction).
    delete static_cast<mfem::HyprePCG *>(ctx.mfem_cached_hypre_pcg);
    ctx.mfem_cached_hypre_pcg = nullptr;
    delete static_cast<mfem::HypreBoomerAMG *>(ctx.mfem_cached_hypre_amg);
    ctx.mfem_cached_hypre_amg = nullptr;
    delete static_cast<mfem::HypreParMatrix *>(ctx.mfem_cached_hypre_par);
    ctx.mfem_cached_hypre_par = nullptr;
    ctx.poisson_solver_setup = false;

    // S09: BC-eliminated matrix is a separate allocation — delete first.
    delete static_cast<mfem::SparseMatrix *>(ctx.mfem_poisson_bc_op);
    ctx.mfem_poisson_bc_op = nullptr;
    // Poisson bilinear form owns the SparseMatrix — don't double-free
    delete static_cast<mfem::GridFunction *>(ctx.mfem_gf_potential);
    delete static_cast<mfem::BilinearForm *>(ctx.mfem_poisson_bilinear);
    delete static_cast<mfem::FiniteElementSpace *>(ctx.mfem_potential_fes);
    delete static_cast<mfem::FiniteElementCollection *>(ctx.mfem_potential_fec);
    ctx.mfem_gf_potential = nullptr;
    ctx.mfem_poisson_bilinear = nullptr;
    ctx.mfem_potential_fes = nullptr;
    ctx.mfem_potential_fec = nullptr;
    ctx.mfem_poisson_rhs = nullptr;
    ctx.mfem_poisson_rhs_vec = nullptr;
    ctx.poisson_ess_tdof_list.clear();
    ctx.poisson_ready = false;
}

bool context_compute_demag_poisson(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_demag_xyz,
    double &demag_energy,
    std::string &error)
{
    if (!ctx.poisson_ready) {
        error = "Poisson demag requested before initialization";
        return false;
    }

    // S03: Assemble RHS b(v) = ∫ M·∇v dV
    mfem::Vector rhs;
    if (!assemble_poisson_rhs(ctx, m_xyz, rhs, error)) {
        return false;
    }

    // S04: Solve -∇²u = -∇·M with Dirichlet BCs
    auto *gf_potential = static_cast<mfem::GridFunction *>(ctx.mfem_gf_potential);
    auto *fes = static_cast<mfem::FiniteElementSpace *>(ctx.mfem_potential_fes);
    mfem::Vector solution(fes->GetTrueVSize());
    gf_potential->GetTrueDofs(solution);  // warm-start

#ifdef MFEM_USE_MPI
    // S10: Prefer Hypre CG+AMG when available (GPU-accelerated)
    if (!solve_poisson_hypre(ctx, rhs, solution, error)) {
        return false;
    }
#else
    if (!solve_poisson(ctx, rhs, solution, error)) {
        return false;
    }
#endif

    // S05: Recover H_demag = -∇u and compute energy
    if (!recover_demag_field(ctx, solution, h_demag_xyz, demag_energy, m_xyz, error)) {
        return false;
    }

    // Store solution for warm-start in next step
    gf_potential->SetFromTrueDofs(solution);

    return true;
}

bool context_refresh_exchange_field_mfem(Context &ctx, std::string &error) {
    double exchange_energy = 0.0;
    double demag_energy = 0.0;
    if (!compute_effective_fields_for_magnetization(
            ctx,
            ctx.m_xyz,
            ctx.h_ex_xyz,
            ctx.h_demag_xyz,
            ctx.h_eff_xyz,
            &exchange_energy,
            &demag_energy,
            error)) {
        return false;
    }
    ctx.mfem_exchange_ready = true;
    return true;
}

bool context_step_exchange_heun_mfem(
    Context &ctx,
    double dt_seconds,
    fullmag_fem_step_stats &stats,
    std::string &error)
{
    if (!ctx.mfem_ready) {
        error = "MFEM step requested before MFEM context initialization";
        return false;
    }
    if (!ctx.enable_exchange && !ctx.enable_demag) {
        error = "native FEM GPU stepper requires at least one effective-field term to be enabled";
        return false;
    }
    if (dt_seconds <= 0.0) {
        error = "native FEM GPU stepper requires a positive dt";
        return false;
    }

    std::vector<double> h_ex_now;
    std::vector<double> h_demag_now;
    std::vector<double> h_eff_now;
    double exchange_energy = 0.0;
    double demag_energy = 0.0;
    if (!compute_effective_fields_for_magnetization(
            ctx,
            ctx.m_xyz,
            h_ex_now,
            h_demag_now,
            h_eff_now,
            &exchange_energy,
            &demag_energy,
            error)) {
        return false;
    }

    std::vector<double> k1;
    double max_rhs_k1 = 0.0;
    llg_rhs_aos(
        ctx.m_xyz,
        h_eff_now,
        ctx.material.gyromagnetic_ratio,
        ctx.material.damping,
        k1,
        max_rhs_k1);
    zero_non_magnetic_nodes_aos(k1, ctx.magnetic_node_mask);

    std::vector<double> predicted = ctx.m_xyz;
    for (size_t i = 0; i < predicted.size(); ++i) {
        predicted[i] += dt_seconds * k1[i];
    }
    normalize_aos_field(predicted);

    std::vector<double> h_ex_pred;
    std::vector<double> h_demag_pred;
    std::vector<double> h_eff_pred;
    if (!compute_effective_fields_for_magnetization(
            ctx,
            predicted,
            h_ex_pred,
            h_demag_pred,
            h_eff_pred,
            nullptr,
            nullptr,
            error)) {
        return false;
    }

    std::vector<double> k2;
    double max_rhs_k2 = 0.0;
    llg_rhs_aos(
        predicted,
        h_eff_pred,
        ctx.material.gyromagnetic_ratio,
        ctx.material.damping,
        k2,
        max_rhs_k2);
    zero_non_magnetic_nodes_aos(k2, ctx.magnetic_node_mask);

    std::vector<double> corrected = ctx.m_xyz;
    for (size_t i = 0; i < corrected.size(); ++i) {
        corrected[i] += 0.5 * dt_seconds * (k1[i] + k2[i]);
    }
    normalize_aos_field(corrected);

    std::vector<double> h_ex_final;
    std::vector<double> h_demag_final;
    std::vector<double> h_eff_final;
    double exchange_energy_final = 0.0;
    double demag_energy_final = 0.0;
    if (!compute_effective_fields_for_magnetization(
            ctx,
            corrected,
            h_ex_final,
            h_demag_final,
            h_eff_final,
            &exchange_energy_final,
            &demag_energy_final,
            error)) {
        return false;
    }

    ctx.m_xyz = std::move(corrected);
    ctx.h_ex_xyz = std::move(h_ex_final);
    ctx.h_demag_xyz = std::move(h_demag_final);
    ctx.h_eff_xyz = std::move(h_eff_final);
    ctx.current_time += dt_seconds;
    ctx.step_count += 1;
    ctx.mfem_exchange_ready = true;

    // Compute post-step RHS from final corrected state (matches CPU metric).
    std::vector<double> rhs_final;
    double max_rhs_final = 0.0;
    llg_rhs_aos(
        ctx.m_xyz,
        ctx.h_eff_xyz,
        ctx.material.gyromagnetic_ratio,
        ctx.material.damping,
        rhs_final,
        max_rhs_final);
    zero_non_magnetic_nodes_aos(rhs_final, ctx.magnetic_node_mask);
    max_rhs_final = max_norm_aos(rhs_final);

    stats.step = ctx.step_count;
    stats.time_seconds = ctx.current_time;
    stats.dt_seconds = dt_seconds;
    stats.exchange_energy_joules = exchange_energy_final;
    stats.demag_energy_joules = demag_energy_final;
    stats.external_energy_joules = external_energy_from_field(ctx, ctx.m_xyz);
    stats.total_energy_joules =
        stats.exchange_energy_joules + stats.demag_energy_joules + stats.external_energy_joules;
    stats.max_effective_field_amplitude = max_norm_aos(ctx.h_eff_xyz);
    stats.max_demag_field_amplitude = max_norm_aos(ctx.h_demag_xyz);
    stats.max_rhs_amplitude = max_rhs_final;
    stats.demag_linear_iterations = 0;
    stats.demag_linear_residual = 0.0;
    stats.wall_time_ns = 0;
    stats.error_estimate = 0.0;
    stats.rejected_attempts = 0;
    stats.dt_suggested = 0.0;
    stats.rhs_evaluations = 2;
    stats.fsal_reused = 0;

    return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Unified explicit Runge-Kutta engine (Butcher tableau-driven)
// ═══════════════════════════════════════════════════════════════════════════

// ── Static Butcher tableaux ───────────────────────────────────────────────

static const ExplicitTableau TABLEAU_HEUN = {
    /* stages */ 2,
    /* c */      {0.0, 1.0},
    /* a */      {{0},
                  {1.0}},
    /* b_hi */   {0.5, 0.5},
    /* b_lo */   {0},
    /* order_hi */  2,
    /* order_est */ 0,
    /* fsal */      false,
};

static const ExplicitTableau TABLEAU_RK4 = {
    /* stages */ 4,
    /* c */      {0.0, 0.5, 0.5, 1.0},
    /* a */      {{0},
                  {0.5},
                  {0.0, 0.5},
                  {0.0, 0.0, 1.0}},
    /* b_hi */   {1.0/6.0, 1.0/3.0, 1.0/3.0, 1.0/6.0},
    /* b_lo */   {0},
    /* order_hi */  4,
    /* order_est */ 0,
    /* fsal */      false,
};

static const ExplicitTableau TABLEAU_BS23 = {
    /* stages */ 4,
    /* c */      {0.0, 0.5, 0.75, 1.0},
    /* a */      {{0},
                  {0.5},
                  {0.0,   0.75},
                  {2.0/9.0, 1.0/3.0, 4.0/9.0}},
    /* b_hi */   {2.0/9.0, 1.0/3.0, 4.0/9.0, 0.0},        // 3rd order
    /* b_lo */   {7.0/24.0, 0.25, 1.0/3.0, 0.125},         // 2nd order (error est)
    /* order_hi */  3,
    /* order_est */ 2,
    /* fsal */      true,  // k[3] at c=1 reuses as k[0] of next step
};

static const ExplicitTableau TABLEAU_DP54 = {
    /* stages */ 7,
    /* c */      {0.0, 0.2, 0.3, 0.8, 8.0/9.0, 1.0, 1.0},
    /* a */      {{0},
                  {0.2},
                  {3.0/40.0,       9.0/40.0},
                  {44.0/45.0,      -56.0/15.0,     32.0/9.0},
                  {19372.0/6561.0, -25360.0/2187.0, 64448.0/6561.0, -212.0/729.0},
                  {9017.0/3168.0,  -355.0/33.0,     46732.0/5247.0,  49.0/176.0,  -5103.0/18656.0},
                  {35.0/384.0,      0.0,             500.0/1113.0,    125.0/192.0, -2187.0/6784.0, 11.0/84.0}},
    /* b_hi */   {35.0/384.0,  0.0,  500.0/1113.0,  125.0/192.0,  -2187.0/6784.0,  11.0/84.0,  0.0},  // 5th order
    /* b_lo */   {5179.0/57600.0, 0.0, 7571.0/16695.0, 393.0/640.0, -92097.0/339200.0, 187.0/2100.0, 1.0/40.0}, // 4th order
    /* order_hi */  5,
    /* order_est */ 4,
    /* fsal */      true,  // k[6] == k[0] of next step
};

const ExplicitTableau &tableau_for_integrator(fullmag_fem_integrator integrator) {
    switch (integrator) {
        case FULLMAG_FEM_INTEGRATOR_RK4:       return TABLEAU_RK4;
        case FULLMAG_FEM_INTEGRATOR_RK23_BS:   return TABLEAU_BS23;
        case FULLMAG_FEM_INTEGRATOR_RK45_DP54: return TABLEAU_DP54;
        default:                               return TABLEAU_HEUN;
    }
}

void stepper_workspace_allocate(StepperWorkspace &ws, size_t dof_len, int stages) {
    if (ws.allocated && ws.dof_len == dof_len) return;
    ws.dof_len = dof_len;
    ws.m_backup.resize(dof_len, 0.0);
    for (int i = 0; i < stages; ++i) {
        ws.k[i].resize(dof_len, 0.0);
    }
    ws.m_stage.resize(dof_len, 0.0);
    ws.h_ex_tmp.resize(dof_len, 0.0);
    ws.h_demag_tmp.resize(dof_len, 0.0);
    ws.h_eff_tmp.resize(dof_len, 0.0);
    ws.err.resize(dof_len, 0.0);
    ws.fsal_valid = false;
    ws.allocated = true;
}

// evaluate_rhs: compute H_eff for state m_state, then LLG RHS into out_k
static bool evaluate_rhs(
    Context &ctx,
    const std::vector<double> &m_state,
    StepperWorkspace &ws,
    std::vector<double> &out_k,
    double *out_max_rhs,
    double *out_exchange_energy,
    double *out_demag_energy,
    std::string &error)
{
    if (!compute_effective_fields_for_magnetization(
            ctx, m_state, ws.h_ex_tmp, ws.h_demag_tmp, ws.h_eff_tmp,
            out_exchange_energy, out_demag_energy, error)) {
        return false;
    }
    double max_rhs = 0.0;
    llg_rhs_aos(m_state, ws.h_eff_tmp,
                ctx.material.gyromagnetic_ratio, ctx.material.damping,
                out_k, max_rhs);
    zero_non_magnetic_nodes_aos(out_k, ctx.magnetic_node_mask);
    if (out_max_rhs) *out_max_rhs = max_rhs;
    return true;
}

// Compute the weighted error norm for adaptive stepping:
// norm = max_i |err_i| / (atol + rtol * max(|m_old_i|, |m_new_i|))
static double compute_error_norm(
    const std::vector<double> &err,
    const std::vector<double> &m_old,
    const std::vector<double> &m_new,
    double atol, double rtol)
{
    double max_scaled = 0.0;
    const size_t n = err.size() / 3u;
    for (size_t i = 0; i < n; ++i) {
        const size_t b = i * 3u;
        for (int d = 0; d < 3; ++d) {
            const double scale = atol + rtol * std::max(std::abs(m_old[b+d]), std::abs(m_new[b+d]));
            max_scaled = std::max(max_scaled, std::abs(err[b+d]) / scale);
        }
    }
    return max_scaled;
}

bool context_step_explicit_rk_mfem(
    Context &ctx,
    const ExplicitTableau &tab,
    double dt_seconds,
    fullmag_fem_step_stats &stats,
    std::string &error)
{
    if (!ctx.mfem_ready) {
        error = "MFEM step requested before MFEM context initialization";
        return false;
    }
    if (!ctx.enable_exchange && !ctx.enable_demag) {
        error = "native FEM GPU stepper requires at least one effective-field term";
        return false;
    }
    if (dt_seconds <= 0.0) {
        error = "native FEM GPU stepper requires a positive dt";
        return false;
    }

    const size_t dof_len = ctx.m_xyz.size();
    stepper_workspace_allocate(ctx.stepper, dof_len, tab.stages);
    auto &ws = ctx.stepper;

    const bool adaptive = (tab.order_est > 0) && ctx.adaptive_dt_enabled;
    double dt = dt_seconds;
    uint32_t rejected = 0;
    uint32_t total_rhs = 0;
    bool fsal_used = false;

    // Outer accept/reject loop (runs once for non-adaptive)
    for (;;) {
        // Save m_backup
        ws.m_backup = ctx.m_xyz;

        // Stage 0: evaluate or reuse FSAL
        if (tab.fsal && ws.fsal_valid) {
            // k[0] already holds the RHS from previous accepted step
            fsal_used = true;
        } else {
            double exchange_energy_s0 = 0.0;
            double demag_energy_s0 = 0.0;
            if (!evaluate_rhs(ctx, ctx.m_xyz, ws, ws.k[0],
                              nullptr, &exchange_energy_s0, &demag_energy_s0, error)) {
                return false;
            }
            total_rhs += 1;
        }

        // Stages 1..s-1
        for (int s = 1; s < tab.stages; ++s) {
            // m_stage = m_backup + dt * sum_j(a[s][j] * k[j])
            for (size_t i = 0; i < dof_len; ++i) {
                double accum = 0.0;
                for (int j = 0; j < s; ++j) {
                    accum += tab.a[s][j] * ws.k[j][i];
                }
                ws.m_stage[i] = ws.m_backup[i] + dt * accum;
            }
            normalize_aos_field(ws.m_stage);

            if (!evaluate_rhs(ctx, ws.m_stage, ws, ws.k[s],
                              nullptr, nullptr, nullptr, error)) {
                return false;
            }
            total_rhs += 1;
        }

        // High-order solution: m_new = m_backup + dt * sum(b_hi[s] * k[s])
        for (size_t i = 0; i < dof_len; ++i) {
            double accum = 0.0;
            for (int s = 0; s < tab.stages; ++s) {
                accum += tab.b_hi[s] * ws.k[s][i];
            }
            ctx.m_xyz[i] = ws.m_backup[i] + dt * accum;
        }
        normalize_aos_field(ctx.m_xyz);

        // For adaptive methods, compute error estimate
        if (adaptive) {
            for (size_t i = 0; i < dof_len; ++i) {
                double err_accum = 0.0;
                for (int s = 0; s < tab.stages; ++s) {
                    err_accum += (tab.b_hi[s] - tab.b_lo[s]) * ws.k[s][i];
                }
                ws.err[i] = dt * err_accum;
            }
            double err_norm = compute_error_norm(ws.err, ws.m_backup, ctx.m_xyz,
                                                  ctx.adaptive_atol, ctx.adaptive_rtol);
            auto result = adaptive_pi_step(ctx, err_norm);
            if (!result.accepted) {
                // Reject: restore, shrink dt, retry
                ctx.m_xyz = ws.m_backup;
                dt = result.dt_next;
                ctx.dt_seconds = dt;
                ws.fsal_valid = false;
                rejected += 1;
                continue;
            }
            stats.error_estimate = err_norm;
            stats.dt_suggested = result.dt_next;
            ctx.dt_seconds = result.dt_next;
        } else {
            stats.error_estimate = 0.0;
            stats.dt_suggested = dt;
        }

        // Accept: FSAL cache for next step
        if (tab.fsal) {
            // Last stage k[stages-1] evaluated at c=1 becomes k[0] of next step
            std::swap(ws.k[0], ws.k[tab.stages - 1]);
            ws.fsal_valid = true;
        } else {
            ws.fsal_valid = false;
        }

        break; // accepted
    }

    // Post-step: compute final fields and energy from accepted state
    double exchange_energy_final = 0.0;
    double demag_energy_final = 0.0;
    std::vector<double> h_ex_final, h_demag_final, h_eff_final;
    if (!compute_effective_fields_for_magnetization(
            ctx, ctx.m_xyz, h_ex_final, h_demag_final, h_eff_final,
            &exchange_energy_final, &demag_energy_final, error)) {
        return false;
    }
    ctx.h_ex_xyz = std::move(h_ex_final);
    ctx.h_demag_xyz = std::move(h_demag_final);
    ctx.h_eff_xyz = std::move(h_eff_final);
    ctx.current_time += dt;
    ctx.step_count += 1;
    ctx.mfem_exchange_ready = true;

    // Post-step RHS for max_dm_dt metric
    std::vector<double> rhs_final;
    double max_rhs_final = 0.0;
    llg_rhs_aos(ctx.m_xyz, ctx.h_eff_xyz,
                ctx.material.gyromagnetic_ratio, ctx.material.damping,
                rhs_final, max_rhs_final);
    zero_non_magnetic_nodes_aos(rhs_final, ctx.magnetic_node_mask);
    max_rhs_final = max_norm_aos(rhs_final);

    stats.step = ctx.step_count;
    stats.time_seconds = ctx.current_time;
    stats.dt_seconds = dt;
    stats.exchange_energy_joules = exchange_energy_final;
    stats.demag_energy_joules = demag_energy_final;
    stats.external_energy_joules = external_energy_from_field(ctx, ctx.m_xyz);
    stats.total_energy_joules =
        stats.exchange_energy_joules + stats.demag_energy_joules + stats.external_energy_joules;
    stats.max_effective_field_amplitude = max_norm_aos(ctx.h_eff_xyz);
    stats.max_demag_field_amplitude = max_norm_aos(ctx.h_demag_xyz);
    stats.max_rhs_amplitude = max_rhs_final;
    stats.demag_linear_iterations = 0;
    stats.demag_linear_residual = 0.0;
    stats.wall_time_ns = 0;
    stats.rejected_attempts = rejected;
    stats.rhs_evaluations = total_rhs;
    stats.fsal_reused = fsal_used ? 1 : 0;

    return true;
}

} // namespace fullmag::fem

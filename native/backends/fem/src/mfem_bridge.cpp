#include "context.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <limits>
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
    for (uint32_t node = 0; node < ctx.n_nodes; ++node) {
        const Vec3 point = node_coords(ctx, node);
        for (int axis = 0; axis < 3; ++axis) {
            bbox_min[axis] = std::min(bbox_min[axis], point[axis]);
            bbox_max[axis] = std::max(bbox_max[axis], point[axis]);
        }
    }
    return true;
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
    for (int i = 0; i < m_component.Size(); ++i) {
        m_component(i) = m_values[static_cast<size_t>(i)];
    }
    mfem::Vector tmp(m_component.Size());
    stiffness.Mult(m_component, tmp);
    h_component.resize(static_cast<size_t>(tmp.Size()));
    for (int i = 0; i < tmp.Size(); ++i) {
        const double mass = lumped_mass[static_cast<size_t>(i)];
        if (mass <= 0.0) {
            error = "encountered non-positive lumped FEM mass while building exchange field";
            return false;
        }
        h_component[static_cast<size_t>(i)] = -prefactor * tmp[i] / mass;
    }
    return true;
}

double vector_norm3(double x, double y, double z) {
    return std::sqrt(x * x + y * y + z * z);
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
    mfem::GridFunction &mx,
    mfem::GridFunction &my,
    mfem::GridFunction &mz,
    double exchange_stiffness)
{
    mfem::Vector tmp(mx.Size());

    double energy = 0.0;
    stiffness.Mult(mx, tmp);
    energy += exchange_stiffness * (mx * tmp);
    stiffness.Mult(my, tmp);
    energy += exchange_stiffness * (my * tmp);
    stiffness.Mult(mz, tmp);
    energy += exchange_stiffness * (mz * tmp);
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
    if (!is_fully_magnetic(ctx)) {
        error =
            "native MFEM exchange scaffold currently supports only fully magnetic meshes (single material marker)";
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
            *gf_mx,
            *gf_my,
            *gf_mz,
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
        if (!compute_demag_for_magnetization(
                ctx, m_xyz, h_demag_xyz, demag, error))
        {
            return false;
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

} // namespace

bool context_initialize_mfem(Context &ctx, std::string &error) {
    try {
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
        auto *device = new mfem::Device("cuda");
        ctx.mfem_device = device;
        ctx.mfem_selected_device_index = selected_device;
#else
        auto *device = new mfem::Device("cpu");
        ctx.mfem_device = device;
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
            const int attr = ctx.element_markers.empty()
                ? 1
                : static_cast<int>(ctx.element_markers[static_cast<size_t>(i)]);
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
        for (int i = 0; i < fes->GetNDofs(); ++i) {
            (*gf_mx)(i) = ctx.mfem_mx[static_cast<size_t>(i)];
            (*gf_my)(i) = ctx.mfem_my[static_cast<size_t>(i)];
            (*gf_mz)(i) = ctx.mfem_mz[static_cast<size_t>(i)];
        }

        auto *exchange_form = new mfem::BilinearForm(fes);
        exchange_form->AddDomainIntegrator(new mfem::DiffusionIntegrator());
        exchange_form->Assemble();
        exchange_form->Finalize();

        auto *mass_form = new mfem::BilinearForm(fes);
        mass_form->AddDomainIntegrator(new mfem::MassIntegrator());
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
    delete static_cast<mfem::Device *>(ctx.mfem_device);
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
    stats.max_rhs_amplitude = std::max(max_rhs_k1, max_rhs_k2);
    stats.demag_linear_iterations = 0;
    stats.demag_linear_residual = 0.0;
    stats.wall_time_ns = 0;

    return true;
}

} // namespace fullmag::fem

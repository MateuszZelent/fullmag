/* Regional Zeeman drive descriptor ownership, basis projection and evaluation. */
#include "cpu/mfem/interactions/zeeman_regional_field.hpp"

#include "context.hpp"
#include "core/fem_element_quadrature_material.hpp"
#include "fem_common.hpp"

#include <algorithm>
#include <cmath>
#include <unordered_set>

namespace fullmag::fem {
namespace {

double tetrahedron_volume(const Context &ctx, uint32_t element)
{
    const size_t base = static_cast<size_t>(element) * 4u;
    const auto coordinate = [&](size_t local, size_t axis) {
        const size_t node = ctx.mesh.cell_nodes[base + local];
        return ctx.mesh.nodes_xyz[3u * node + axis];
    };
    const double ax = coordinate(1, 0) - coordinate(0, 0);
    const double ay = coordinate(1, 1) - coordinate(0, 1);
    const double az = coordinate(1, 2) - coordinate(0, 2);
    const double bx = coordinate(2, 0) - coordinate(0, 0);
    const double by = coordinate(2, 1) - coordinate(0, 1);
    const double bz = coordinate(2, 2) - coordinate(0, 2);
    const double cx = coordinate(3, 0) - coordinate(0, 0);
    const double cy = coordinate(3, 1) - coordinate(0, 1);
    const double cz = coordinate(3, 2) - coordinate(0, 2);
    return std::abs(
        ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) +
        az * (bx * cy - by * cx)) / 6.0;
}

using Point = std::array<double, 3>;
using Tetra = std::array<Point, 4>;
using Moments = std::array<double, 4>;

Point midpoint(const Point &a, const Point &b)
{
    return {(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5};
}

double determinant(const Point &a, const Point &b, const Point &c)
{
    return a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0]);
}

double tetra_volume(const Tetra &tetra)
{
    Point a{}, b{}, c{};
    for (size_t axis = 0; axis < 3; ++axis) {
        a[axis] = tetra[1][axis] - tetra[0][axis];
        b[axis] = tetra[2][axis] - tetra[0][axis];
        c[axis] = tetra[3][axis] - tetra[0][axis];
    }
    return std::abs(determinant(a, b, c)) / 6.0;
}

Moments original_barycentric(const Tetra &tetra, const Point &point)
{
    Point a{}, b{}, c{}, p{};
    for (size_t axis = 0; axis < 3; ++axis) {
        a[axis] = tetra[1][axis] - tetra[0][axis];
        b[axis] = tetra[2][axis] - tetra[0][axis];
        c[axis] = tetra[3][axis] - tetra[0][axis];
        p[axis] = point[axis] - tetra[0][axis];
    }
    const double det = determinant(a, b, c);
    const double l1 = determinant(p, b, c) / det;
    const double l2 = determinant(a, p, c) / det;
    const double l3 = determinant(a, b, p) / det;
    return {1.0 - l1 - l2 - l3, l1, l2, l3};
}

double spatial_sinc(const RegionalFieldDriveRuntime &drive, const Point &point)
{
    if (drive.sinc_period_m <= 0.0) return 1.0;
    const double coordinate = drive.sinc_axis[0] * point[0] +
        drive.sinc_axis[1] * point[1] + drive.sinc_axis[2] * point[2];
    const double distance = coordinate - drive.sinc_center_m;
    if (drive.sinc_width_m > 0.0 && std::abs(distance) > 0.5 * drive.sinc_width_m) return 0.0;
    const double argument = 3.14159265358979323846 * distance / drive.sinc_period_m;
    const double sinc = std::abs(argument) < 1.0e-4
        ? 1.0 - argument * argument / 6.0 + std::pow(argument, 4) / 120.0
        : std::sin(argument) / argument;
    if (drive.sinc_window == FULLMAG_FEM_SPATIAL_WINDOW_HANN && drive.sinc_width_m > 0.0) {
        return sinc * 0.5 * (1.0 + std::cos(2.0 * 3.14159265358979323846 * distance / drive.sinc_width_m));
    }
    return sinc;
}

bool geometry_contains(
    const RegionalFieldDriveRuntime &drive,
    uint32_t index,
    const Point &point)
{
    const auto &node = drive.geometry_nodes[index];
    switch (node.kind) {
    case FULLMAG_FEM_GEOMETRY_BOX:
        return std::abs(point[0] - node.center_m[0]) <= 0.5 * node.size_m[0] &&
            std::abs(point[1] - node.center_m[1]) <= 0.5 * node.size_m[1] &&
            std::abs(point[2] - node.center_m[2]) <= 0.5 * node.size_m[2];
    case FULLMAG_FEM_GEOMETRY_CYLINDER: {
        const Point delta{point[0] - node.center_m[0], point[1] - node.center_m[1], point[2] - node.center_m[2]};
        const double axial = delta[0] * node.axis[0] + delta[1] * node.axis[1] + delta[2] * node.axis[2];
        const double radial2 = delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2] - axial * axial;
        return std::abs(axial) <= 0.5 * node.height_m && radial2 <= node.radius_m * node.radius_m;
    }
    case FULLMAG_FEM_GEOMETRY_TRANSLATE: {
        const Point translated{point[0] - node.translation_m[0], point[1] - node.translation_m[1], point[2] - node.translation_m[2]};
        return geometry_contains(drive, node.child_a, translated);
    }
    case FULLMAG_FEM_GEOMETRY_DIFFERENCE:
        return geometry_contains(drive, node.child_a, point) && !geometry_contains(drive, node.child_b, point);
    case FULLMAG_FEM_GEOMETRY_UNION:
        return geometry_contains(drive, node.child_a, point) || geometry_contains(drive, node.child_b, point);
    case FULLMAG_FEM_GEOMETRY_INTERSECTION:
        return geometry_contains(drive, node.child_a, point) && geometry_contains(drive, node.child_b, point);
    default:
        return false;
    }
}

enum class CellRelation { Outside, Inside, Boundary };

CellRelation geometry_cell_relation(
    const RegionalFieldDriveRuntime &drive,
    uint32_t index,
    const Tetra &tetra)
{
    const auto &node = drive.geometry_nodes[index];
    const auto all_inside = [&]() {
        return std::all_of(tetra.begin(), tetra.end(), [&](const Point &point) {
            return geometry_contains(drive, index, point);
        });
    };
    switch (node.kind) {
    case FULLMAG_FEM_GEOMETRY_BOX: {
        if (all_inside()) return CellRelation::Inside;
        for (size_t axis = 0; axis < 3; ++axis) {
            const auto [minimum, maximum] = std::minmax_element(
                tetra.begin(), tetra.end(), [axis](const Point &a, const Point &b) {
                    return a[axis] < b[axis];
                });
            const double lower = node.center_m[axis] - 0.5 * node.size_m[axis];
            const double upper = node.center_m[axis] + 0.5 * node.size_m[axis];
            if ((*maximum)[axis] <= lower || (*minimum)[axis] >= upper) {
                return CellRelation::Outside;
            }
        }
        return CellRelation::Boundary;
    }
    case FULLMAG_FEM_GEOMETRY_CYLINDER:
        // A finite cylinder is convex, hence all vertices inside implies the
        // complete tetrahedron is inside. Conservative boundary subdivision
        // handles every other case without falsely discarding an intersection.
        return all_inside() ? CellRelation::Inside : CellRelation::Boundary;
    case FULLMAG_FEM_GEOMETRY_TRANSLATE: {
        Tetra translated = tetra;
        for (auto &point : translated) for (size_t axis = 0; axis < 3; ++axis) {
            point[axis] -= node.translation_m[axis];
        }
        return geometry_cell_relation(drive, node.child_a, translated);
    }
    case FULLMAG_FEM_GEOMETRY_UNION: {
        const auto a = geometry_cell_relation(drive, node.child_a, tetra);
        const auto b = geometry_cell_relation(drive, node.child_b, tetra);
        if (a == CellRelation::Inside || b == CellRelation::Inside) return CellRelation::Inside;
        if (a == CellRelation::Outside && b == CellRelation::Outside) return CellRelation::Outside;
        return CellRelation::Boundary;
    }
    case FULLMAG_FEM_GEOMETRY_INTERSECTION: {
        const auto a = geometry_cell_relation(drive, node.child_a, tetra);
        const auto b = geometry_cell_relation(drive, node.child_b, tetra);
        if (a == CellRelation::Outside || b == CellRelation::Outside) return CellRelation::Outside;
        if (a == CellRelation::Inside && b == CellRelation::Inside) return CellRelation::Inside;
        return CellRelation::Boundary;
    }
    case FULLMAG_FEM_GEOMETRY_DIFFERENCE: {
        const auto a = geometry_cell_relation(drive, node.child_a, tetra);
        const auto b = geometry_cell_relation(drive, node.child_b, tetra);
        if (a == CellRelation::Outside || b == CellRelation::Inside) return CellRelation::Outside;
        if (a == CellRelation::Inside && b == CellRelation::Outside) return CellRelation::Inside;
        return CellRelation::Boundary;
    }
    default:
        return CellRelation::Outside;
    }
}

double spatial_profile_value(const RegionalFieldDriveRuntime &drive, const Point &point)
{
    if (drive.spatial_profile_kind == FULLMAG_FEM_SPATIAL_PROFILE_GEOMETRY_MASK &&
        !geometry_contains(drive, drive.geometry_root_index, point)) return 0.0;
    if (drive.spatial_profile_kind == FULLMAG_FEM_SPATIAL_PROFILE_UNIFORM) return 1.0;
    if (drive.spatial_profile_kind == FULLMAG_FEM_SPATIAL_PROFILE_GAUSSIAN_PLANE_WAVE) {
        const double dx = (point[0] - drive.gaussian_center_x_m) / drive.gaussian_sigma_x_m;
        const double dy = (point[1] - drive.gaussian_center_y_m) / drive.gaussian_sigma_y_m;
        const double envelope = std::exp(-0.5 * (dx * dx + dy * dy));
        const double carrier = 2.0 * 3.14159265358979323846 *
            (point[0] - drive.gaussian_carrier_origin_x_m) /
            drive.gaussian_wavelength_m + drive.gaussian_carrier_phase_rad;
        return envelope * std::cos(carrier);
    }
    return spatial_sinc(drive, point);
}

template <size_t N>
Moments integrate_tetra_rule(
    const RegionalFieldDriveRuntime &drive,
    const Tetra &original,
    const Tetra &subtetra,
    const std::array<double, N> &points,
    const std::array<double, N> &weights)
{
    Moments result{};
    const double jacobian = 6.0 * tetra_volume(subtetra);
    for (size_t iu = 0; iu < N; ++iu) for (size_t iv = 0; iv < N; ++iv) for (size_t iw = 0; iw < N; ++iw) {
        const double u = points[iu];
        const double v = points[iv];
        const double w = points[iw];
        const std::array<double, 4> local{
            1.0 - u - (1.0 - u) * v - (1.0 - u) * (1.0 - v) * w,
            u,
            (1.0 - u) * v,
            (1.0 - u) * (1.0 - v) * w,
        };
        Point world{};
        for (size_t vertex = 0; vertex < 4; ++vertex) for (size_t axis = 0; axis < 3; ++axis) {
            world[axis] += local[vertex] * subtetra[vertex][axis];
        }
        const double factor = spatial_profile_value(drive, world) * jacobian *
            (1.0 - u) * (1.0 - u) * (1.0 - v) * weights[iu] * weights[iv] * weights[iw];
        const Moments basis = original_barycentric(original, world);
        for (size_t local_node = 0; local_node < 4; ++local_node) result[local_node] += factor * basis[local_node];
    }
    return result;
}

std::array<Tetra, 8> subdivide_tetra(const Tetra &t)
{
    const Point ab = midpoint(t[0], t[1]);
    const Point ac = midpoint(t[0], t[2]);
    const Point ad = midpoint(t[0], t[3]);
    const Point bc = midpoint(t[1], t[2]);
    const Point bd = midpoint(t[1], t[3]);
    const Point cd = midpoint(t[2], t[3]);
    return {{
        {{t[0], ab, ac, ad}}, {{ab, t[1], bc, bd}},
        {{ac, bc, t[2], cd}}, {{ad, bd, cd, t[3]}},
        {{ab, ac, ad, cd}}, {{ab, ac, bc, cd}},
        {{ab, bc, bd, cd}}, {{ab, ad, bd, cd}},
    }};
}

bool integrate_profile_adaptive(
    const RegionalFieldDriveRuntime &drive,
    const Tetra &original,
    const Tetra &subtetra,
    unsigned depth,
    Moments &out)
{
    constexpr std::array<double, 2> p2{0.2113248654051871, 0.7886751345948129};
    constexpr std::array<double, 2> w2{0.5, 0.5};
    constexpr std::array<double, 4> p4{0.06943184420297371, 0.33000947820757187, 0.6699905217924281, 0.9305681557970262};
    constexpr std::array<double, 4> w4{0.17392742256872692, 0.32607257743127307, 0.32607257743127307, 0.17392742256872692};
    if ((drive.spatial_profile_kind == FULLMAG_FEM_SPATIAL_PROFILE_SINC ||
         drive.spatial_profile_kind == FULLMAG_FEM_SPATIAL_PROFILE_GAUSSIAN_PLANE_WAVE) &&
        depth == 0) {
        // Spatial sinc/Gaussian profile is smooth. The tensor Gauss-4 Duffy rule is the
        // production projection; recursive refinement is reserved for
        // discontinuous geometry-mask boundaries. A sinc wavelength below
        // the element scale is a planner/mesh-resolution error, not something
        // exponentially deep quadrature can repair.
        const Moments high = integrate_tetra_rule(drive, original, subtetra, p4, w4);
        for (size_t i = 0; i < 4; ++i) out[i] += high[i];
        return true;
    }
    if (drive.spatial_profile_kind == FULLMAG_FEM_SPATIAL_PROFILE_GEOMETRY_MASK) {
        const auto relation = geometry_cell_relation(
            drive, drive.geometry_root_index, subtetra);
        if (relation == CellRelation::Outside) return true;
        if (relation == CellRelation::Inside) {
            const Moments high = integrate_tetra_rule(drive, original, subtetra, p4, w4);
            for (size_t i = 0; i < 4; ++i) out[i] += high[i];
            return true;
        }
    }
    const Moments low = integrate_tetra_rule(drive, original, subtetra, p2, w2);
    const Moments high = integrate_tetra_rule(drive, original, subtetra, p4, w4);
    double error = 0.0;
    for (size_t i = 0; i < 4; ++i) error = std::max(error, std::abs(high[i] - low[i]));
    if (error <= 1.0e-6 * tetra_volume(subtetra)) {
        for (size_t i = 0; i < 4; ++i) out[i] += high[i];
        return true;
    }
    if (depth == 10) return false;
    for (const auto &child : subdivide_tetra(subtetra)) {
        if (!integrate_profile_adaptive(drive, original, child, depth + 1, out)) return false;
    }
    return true;
}

} // namespace

bool copy_regional_field_drive_plan(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error)
{
    if ((plan.regional_field_drive_count == 0) != (plan.regional_field_drives == nullptr)) {
        error = "regional field drives null/count mismatch";
        return false;
    }
    if (!std::isfinite(plan.stage_start_time_s) || plan.stage_start_time_s < 0.0) {
        error = "regional field drive stage start time must be finite and non-negative";
        return false;
    }
    ctx.zeeman.regional_drives.clear();
    ctx.zeeman.stage_start_time_s = plan.stage_start_time_s;
    for (uint64_t index = 0; index < plan.regional_field_drive_count; ++index) {
        const auto &source = plan.regional_field_drives[index];
        if (source.abi_version != FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION ||
            source.struct_size != sizeof(fullmag_fem_regional_field_drive_desc)) {
            error = "regional field drive ABI version/size mismatch";
            return false;
        }
        if (source.target.abi_version != FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION ||
            source.target.struct_size != sizeof(fullmag_fem_field_target_desc) ||
            source.spatial_profile.abi_version != FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION ||
            source.spatial_profile.struct_size != sizeof(fullmag_fem_spatial_profile_desc)) {
            error = "regional field drive target/profile ABI version/size mismatch";
            return false;
        }
        if ((source.target.element_marker_count == 0) !=
            (source.target.element_markers == nullptr)) {
            error = "regional field drive target markers null/count mismatch";
            return false;
        }
        if (source.target.kind > FULLMAG_FEM_FIELD_TARGET_ELEMENT_MARKERS) {
            error = "regional field drive target kind is unsupported";
            return false;
        }
        if (source.target.kind == FULLMAG_FEM_FIELD_TARGET_ELEMENT_MARKERS &&
            source.target.element_marker_count == 0) {
            error = "regional field drive marker target must not be empty";
            return false;
        }
        if (source.spatial_profile.kind > FULLMAG_FEM_SPATIAL_PROFILE_GAUSSIAN_PLANE_WAVE) {
            error = "regional field drive spatial profile kind is unsupported";
            return false;
        }
        const double norm = std::sqrt(
            source.direction[0] * source.direction[0] +
            source.direction[1] * source.direction[1] +
            source.direction[2] * source.direction[2]);
        if (!std::isfinite(source.amplitude_b_t) || source.amplitude_b_t < 0.0 ||
            !std::isfinite(norm) || norm <= 0.0) {
            error = "regional field drive amplitude must be finite and non-negative; direction must be finite and nonzero";
            return false;
        }
        if (source.time_origin > FULLMAG_FEM_TIME_ABSOLUTE) {
            error = "regional field drive time origin is unsupported";
            return false;
        }
        RegionalFieldDriveRuntime drive;
        drive.stable_id_hash = source.stable_id_hash;
        drive.target_kind = source.target.kind;
        drive.spatial_profile_kind = source.spatial_profile.kind;
        drive.sinc_axis = {
            source.spatial_profile.sinc_axis[0],
            source.spatial_profile.sinc_axis[1],
            source.spatial_profile.sinc_axis[2],
        };
        drive.sinc_period_m = source.spatial_profile.sinc_period_m;
        drive.sinc_center_m = source.spatial_profile.sinc_center_m;
        drive.sinc_width_m = source.spatial_profile.sinc_width_m;
        drive.sinc_window = source.spatial_profile.sinc_window;
        drive.gaussian_center_x_m = source.spatial_profile.gaussian_center_x_m;
        drive.gaussian_center_y_m = source.spatial_profile.gaussian_center_y_m;
        drive.gaussian_carrier_origin_x_m = source.spatial_profile.gaussian_carrier_origin_x_m;
        drive.gaussian_sigma_x_m = source.spatial_profile.gaussian_sigma_x_m;
        drive.gaussian_sigma_y_m = source.spatial_profile.gaussian_sigma_y_m;
        drive.gaussian_wavelength_m = source.spatial_profile.gaussian_wavelength_m;
        drive.gaussian_carrier_phase_rad = source.spatial_profile.gaussian_carrier_phase_rad;
        if (drive.spatial_profile_kind == FULLMAG_FEM_SPATIAL_PROFILE_SINC &&
            (!std::isfinite(drive.sinc_period_m) || drive.sinc_period_m <= 0.0)) {
            error = "regional field drive spatial sinc period must be finite and positive";
            return false;
        }
        if (drive.spatial_profile_kind == FULLMAG_FEM_SPATIAL_PROFILE_GAUSSIAN_PLANE_WAVE &&
            (!std::isfinite(drive.gaussian_center_x_m) ||
             !std::isfinite(drive.gaussian_center_y_m) ||
             !std::isfinite(drive.gaussian_carrier_origin_x_m) ||
             !std::isfinite(drive.gaussian_sigma_x_m) || drive.gaussian_sigma_x_m <= 0.0 ||
             !std::isfinite(drive.gaussian_sigma_y_m) || drive.gaussian_sigma_y_m <= 0.0 ||
             !std::isfinite(drive.gaussian_wavelength_m) || drive.gaussian_wavelength_m <= 0.0 ||
             !std::isfinite(drive.gaussian_carrier_phase_rad))) {
            error = "regional field drive Gaussian plane-wave profile parameters are invalid";
            return false;
        }
        if (drive.spatial_profile_kind == FULLMAG_FEM_SPATIAL_PROFILE_GEOMETRY_MASK) {
            const auto *geometry = source.spatial_profile.geometry_mask;
            if (geometry == nullptr ||
                geometry->abi_version != FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION ||
                geometry->struct_size != sizeof(fullmag_fem_geometry_mask_desc) ||
                geometry->nodes == nullptr || geometry->node_count == 0 ||
                geometry->root_index >= geometry->node_count) {
                error = "regional field drive geometry mask descriptor is invalid";
                return false;
            }
            drive.geometry_nodes.assign(geometry->nodes, geometry->nodes + geometry->node_count);
            drive.geometry_root_index = geometry->root_index;
            for (const auto &node : drive.geometry_nodes) {
                if (node.kind < FULLMAG_FEM_GEOMETRY_BOX ||
                    node.kind > FULLMAG_FEM_GEOMETRY_INTERSECTION ||
                    ((node.kind >= FULLMAG_FEM_GEOMETRY_TRANSLATE) &&
                     node.child_a >= drive.geometry_nodes.size()) ||
                    ((node.kind >= FULLMAG_FEM_GEOMETRY_DIFFERENCE) &&
                     node.child_b >= drive.geometry_nodes.size())) {
                    error = "regional field drive geometry mask node kind/child index is invalid";
                    return false;
                }
            }
        }
        drive.amplitude_b_t = source.amplitude_b_t;
        drive.direction = {source.direction[0] / norm, source.direction[1] / norm, source.direction[2] / norm};
        drive.time_origin = source.time_origin;
        if (source.target.element_marker_count > 0) {
            drive.target_element_markers.assign(
                source.target.element_markers,
                source.target.element_markers + source.target.element_marker_count);
        }
        if (!copy_time_dependence(source.waveform, drive.waveform, error)) return false;
        ctx.zeeman.regional_drives.push_back(std::move(drive));
    }
    return true;
}

bool project_regional_field_drive_bases(Context &ctx, std::string &error)
{
    constexpr double mu0 = 1.2566370614359172953850573533118e-6;
    const size_t nodes = ctx.mesh.n_nodes;
    if (!ctx.zeeman.regional_drives.empty() && ctx.mesh.node_volumes.size() != nodes) {
        error = "regional field drive projection requires published nodal integration weights";
        return false;
    }
    for (auto &drive : ctx.zeeman.regional_drives) {
        drive.basis_h_xyz.assign(nodes * 3u, 0.0);
        if (drive.target_kind == FULLMAG_FEM_FIELD_TARGET_GLOBAL &&
            drive.spatial_profile_kind == FULLMAG_FEM_SPATIAL_PROFILE_UNIFORM) {
            // A global uniform field is represented exactly by its nodal value.
            // This avoids imposing tetrahedral arity on the canonical mixed
            // prism/pyramid/tet CSR mesh; MFEM has already published the
            // magnetic nodal mass weights used to identify active nodes.
            const double amplitude_h = drive.amplitude_b_t / mu0;
            for (size_t node = 0; node < nodes; ++node) {
                if (ctx.mesh.node_volumes[node] <= 0.0) continue;
                const size_t base = node * 3u;
                for (size_t c = 0; c < 3u; ++c) {
                    drive.basis_h_xyz[base + c] = amplitude_h * drive.direction[c];
                }
            }
            continue;
        }
        const bool tetrahedral = std::all_of(
            ctx.mesh.cell_types.begin(), ctx.mesh.cell_types.end(),
            [](uint32_t type) { return type == FULLMAG_FEM_CELL_TET4; });
        if (!tetrahedral) {
            error = "mixed FEM regional field drive projection currently supports only a global uniform spatial profile";
            return false;
        }
        std::vector<double> target_mass(nodes, 0.0);
        const std::unordered_set<uint32_t> markers(
            drive.target_element_markers.begin(), drive.target_element_markers.end());
        for (uint32_t element = 0; element < ctx.mesh.n_elements; ++element) {
            const bool selected = drive.target_kind == FULLMAG_FEM_FIELD_TARGET_GLOBAL ||
                (!ctx.mesh.cell_markers.empty() && markers.count(ctx.mesh.cell_markers[element]) != 0u);
            if (!selected || (!ctx.mesh.magnetic_element_mask.empty() &&
                ctx.mesh.magnetic_element_mask[element] == 0u)) continue;
            const size_t ebase = static_cast<size_t>(element) * 4u;
            const double volume = tetrahedron_volume(ctx, element);
            if (drive.spatial_profile_kind == FULLMAG_FEM_SPATIAL_PROFILE_UNIFORM) {
                for (size_t local = 0; local < 4u; ++local) {
                    target_mass[ctx.mesh.cell_nodes[ebase + local]] += volume * 0.25;
                }
            } else {
                Tetra tetra{};
                for (size_t local = 0; local < 4; ++local) {
                    const size_t node = ctx.mesh.cell_nodes[ebase + local];
                    tetra[local] = {
                        ctx.mesh.nodes_xyz[3u * node],
                        ctx.mesh.nodes_xyz[3u * node + 1],
                        ctx.mesh.nodes_xyz[3u * node + 2],
                    };
                }
                Moments moments{};
                if (!integrate_profile_adaptive(drive, tetra, tetra, 0, moments)) {
                    error = "regional field drive adaptive tetra projection did not converge for element " +
                        std::to_string(element) + " at maximum depth 10";
                    return false;
                }
                for (size_t local = 0; local < 4; ++local) {
                    target_mass[ctx.mesh.cell_nodes[ebase + local]] += moments[local];
                }
            }
        }
        const double amplitude_h = drive.amplitude_b_t / mu0;
        for (size_t node = 0; node < nodes; ++node) {
            const double denominator = ctx.mesh.node_volumes[node];
            const double weight = denominator > 0.0 ? target_mass[node] / denominator : 0.0;
            const size_t base = node * 3u;
            for (size_t c = 0; c < 3u; ++c) {
                drive.basis_h_xyz[base + c] = amplitude_h * drive.direction[c] * weight;
            }
        }
        for (size_t pair = 0; pair + 1 < ctx.mesh.periodic_node_pairs.size(); pair += 2) {
            const size_t a = ctx.mesh.periodic_node_pairs[pair];
            const size_t b = ctx.mesh.periodic_node_pairs[pair + 1];
            double max_mismatch = 0.0;
            for (size_t c = 0; c < 3u; ++c) {
                max_mismatch = std::max(max_mismatch,
                    std::abs(drive.basis_h_xyz[3u * a + c] - drive.basis_h_xyz[3u * b + c]));
                if (max_mismatch >
                    1.0e-12 * std::max(1.0, std::abs(amplitude_h))) {
                    error = "regional field drive basis violates periodic node pair " +
                        std::to_string(pair / 2u) + " (nodes " + std::to_string(a) + "," +
                        std::to_string(b) + ", max mismatch " + std::to_string(max_mismatch) + ")";
                    return false;
                }
            }
        }
    }
    ctx.zeeman.h_drive_xyz.assign(nodes * 3u, 0.0);
    return true;
}

void materialize_regional_field_drive(Context &ctx, double evaluation_time_s)
{
    const size_t expected = static_cast<size_t>(ctx.mesh.n_nodes) * 3u;
    if (ctx.zeeman.h_drive_xyz.size() != expected) {
        ctx.zeeman.h_drive_xyz.assign(expected, 0.0);
    }
    std::fill(ctx.zeeman.h_drive_xyz.begin(), ctx.zeeman.h_drive_xyz.end(), 0.0);
    for (const auto &drive : ctx.zeeman.regional_drives) {
        const double time = drive.time_origin == FULLMAG_FEM_TIME_STAGE_LOCAL
            ? evaluation_time_s - ctx.zeeman.stage_start_time_s : evaluation_time_s;
        const double value = evaluate_time_dependence(drive.waveform, time);
        for (size_t i = 0; i < ctx.zeeman.h_drive_xyz.size(); ++i) {
            ctx.zeeman.h_drive_xyz[i] += value * drive.basis_h_xyz[i];
        }
    }
    ctx.zeeman.last_evaluation_time_s = evaluation_time_s;
}

double regional_field_drive_energy(const Context &ctx, const std::vector<double> &m_xyz)
{
    if (!ctx.material_fields.Ms_element_field.empty() &&
        ctx.material_fields.runtime.has_value()) {
        return -kMu0 * ctx.material_fields.runtime->ms_weighted_aos3_mass_bilinear(
            m_xyz, ctx.zeeman.h_drive_xyz);
    }
    const size_t nodes = std::min({
        ctx.integration_weights.mfem_lumped_mass.size(),
        m_xyz.size() / 3u,
        ctx.zeeman.h_drive_xyz.size() / 3u});
    double energy = 0.0;
    for (size_t node = 0; node < nodes; ++node) {
        const size_t base = node * 3u;
        const double mdoth = m_xyz[base] * ctx.zeeman.h_drive_xyz[base] +
            m_xyz[base + 1] * ctx.zeeman.h_drive_xyz[base + 1] +
            m_xyz[base + 2] * ctx.zeeman.h_drive_xyz[base + 2];
        const double ms = scalar_field_value(
            ctx.material_fields.Ms_field, node,
            ctx.material_fields.material.saturation_magnetisation);
        energy += -kMu0 * ms * mdoth * ctx.integration_weights.mfem_lumped_mass[node];
    }
    return energy;
}

} // namespace fullmag::fem

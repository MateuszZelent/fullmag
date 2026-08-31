/*
 * Diagnostic SP4 probe for an all-prism shared magnetic/air domain.
 *
 * This intentionally calls the native FEM ABI directly.  The production
 * planner currently rejects a pure prism6 topology before it reaches the
 * backend, even though the Poisson backend supports prism6 and only lowers
 * the scalar-potential order when pyramid5 cells are present.  Keeping this
 * probe next to the SP4 qualification sources makes that gap reproducible
 * without weakening the planner's fail-closed contract.
 */

#include "fullmag_fem.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

constexpr double kFilmX = 500.0e-9;
constexpr double kFilmY = 125.0e-9;
constexpr double kFilmZ = 3.0e-9;
constexpr double kAirboxX = 700.0e-9;
constexpr double kAirboxY = 250.0e-9;
constexpr double kAirboxZ = 250.0e-9;
constexpr double kMs = 8.0e5;
constexpr double kAex = 1.3e-11;
constexpr double kAlpha = 0.02;
constexpr double kGammaMu0 = 2.211e5;
constexpr double kFdmInitialDemagJ = 7.137838407337884e-19;
constexpr double kOuterGrowth = 1.15;
constexpr std::uint32_t kFilmMarker = 1u;
constexpr std::uint32_t kInterfaceMarker = 10u;
constexpr std::uint32_t kOuterMarker = 99u;

struct ProbeConfig {
    std::uint32_t film_layers = 1u;
    std::uint32_t film_x_intervals = 128u;
    std::uint32_t film_y_intervals = 32u;
    std::uint32_t outer_x_intervals_per_side = 5u;
    std::uint32_t outer_y_intervals_per_side = 4u;
    std::uint32_t outer_z_intervals_per_side = 7u;
    std::uint64_t relaxation_steps = 0u;
};

struct FaceKey {
    std::uint8_t arity = 0u;
    std::array<std::uint32_t, 4> nodes{{0u, 0u, 0u, 0u}};

    bool operator<(const FaceKey &other) const
    {
        return arity < other.arity || (arity == other.arity && nodes < other.nodes);
    }
};

struct FaceOwners {
    std::array<std::uint32_t, 4> nodes{{0u, 0u, 0u, 0u}};
    std::array<std::uint32_t, 2> markers{{0u, 0u}};
    std::uint8_t arity = 0u;
    std::uint8_t owner_count = 0u;
};

struct MeshBuffers {
    std::vector<double> nodes_xyz;
    std::vector<std::uint32_t> cell_types;
    std::vector<std::uint32_t> cell_offsets;
    std::vector<std::uint32_t> cell_nodes;
    std::vector<std::uint64_t> cell_global_ordinals;
    std::vector<std::uint32_t> cell_markers;
    std::vector<std::uint32_t> facet_types;
    std::vector<std::uint32_t> facet_roles;
    std::vector<std::uint32_t> facet_offsets;
    std::vector<std::uint32_t> facet_nodes;
    std::vector<std::uint64_t> facet_global_ordinals;
    std::vector<std::uint32_t> facet_markers;
    std::vector<double> initial_m;
    std::uint64_t magnetic_cell_count = 0u;
    std::uint64_t exterior_facet_count = 0u;
    std::uint64_t interface_facet_count = 0u;
};

[[noreturn]] void fail(const std::string &message)
{
    throw std::runtime_error(message);
}

std::uint32_t parse_u32(const char *text, const char *name)
{
    if (text == nullptr || *text == '\0') {
        fail(std::string(name) + " must be a positive integer");
    }
    char *end = nullptr;
    const unsigned long value = std::strtoul(text, &end, 10);
    if (end == text || *end != '\0' || value == 0ul ||
        value > std::numeric_limits<std::uint32_t>::max()) {
        fail(std::string(name) + " must be a positive uint32");
    }
    return static_cast<std::uint32_t>(value);
}

std::uint64_t parse_u64_allow_zero(const char *text, const char *name)
{
    if (text == nullptr || *text == '\0') {
        fail(std::string(name) + " must be a nonnegative integer");
    }
    char *end = nullptr;
    const unsigned long long value = std::strtoull(text, &end, 10);
    if (end == text || *end != '\0') {
        fail(std::string(name) + " must be a nonnegative uint64");
    }
    return static_cast<std::uint64_t>(value);
}

ProbeConfig parse_config(int argc, char **argv)
{
    if (argc > 8) {
        fail(
            "usage: prism_shared_airbox_probe [film_layers] [film_nx] [film_ny] "
            "[outer_nx_per_side] [outer_ny_per_side] [outer_nz_per_side] "
            "[relaxation_steps]");
    }
    ProbeConfig config{};
    if (argc > 1) config.film_layers = parse_u32(argv[1], "film_layers");
    if (argc > 2) config.film_x_intervals = parse_u32(argv[2], "film_nx");
    if (argc > 3) config.film_y_intervals = parse_u32(argv[3], "film_ny");
    if (argc > 4) {
        config.outer_x_intervals_per_side = parse_u32(argv[4], "outer_nx_per_side");
    }
    if (argc > 5) {
        config.outer_y_intervals_per_side = parse_u32(argv[5], "outer_ny_per_side");
    }
    if (argc > 6) {
        config.outer_z_intervals_per_side = parse_u32(argv[6], "outer_nz_per_side");
    }
    if (argc > 7) {
        config.relaxation_steps = parse_u64_allow_zero(argv[7], "relaxation_steps");
    }
    if (config.film_layers > 3u) {
        fail("film_layers must be in {1,2,3} for the SP4 prism qualification matrix");
    }
    return config;
}

std::vector<double> interval_axis(
    double left,
    double inner_left,
    double inner_right,
    double right,
    std::uint32_t left_count,
    std::uint32_t inner_count,
    std::uint32_t right_count)
{
    std::vector<double> values;
    values.reserve(static_cast<std::size_t>(left_count + inner_count + right_count) + 1u);
    const auto append_graded = [&values](
                                   double begin,
                                   double end,
                                   std::uint32_t count,
                                   bool first,
                                   bool largest_cell_first) {
        if (first) {
            values.push_back(begin);
        }
        double weight_sum = 0.0;
        for (std::uint32_t index = 0u; index < count; ++index) {
            weight_sum += std::pow(kOuterGrowth, static_cast<double>(index));
        }
        double cursor = begin;
        for (std::uint32_t index = 0u; index < count; ++index) {
            const std::uint32_t exponent = largest_cell_first
                ? count - 1u - index
                : index;
            const double width = (end - begin) *
                std::pow(kOuterGrowth, static_cast<double>(exponent)) / weight_sum;
            cursor += width;
            values.push_back(index + 1u == count ? end : cursor);
        }
    };
    const auto append_uniform = [&values](double begin, double end, std::uint32_t count) {
        for (std::uint32_t index = 1u; index <= count; ++index) {
            const double fraction = static_cast<double>(index) / static_cast<double>(count);
            values.push_back(index == count ? end : begin + fraction * (end - begin));
        }
    };
    append_graded(left, inner_left, left_count, true, true);
    append_uniform(inner_left, inner_right, inner_count);
    append_graded(inner_right, right, right_count, false, false);
    return values;
}

FaceKey face_key(const std::array<std::uint32_t, 4> &nodes, std::uint8_t arity)
{
    FaceKey key{};
    key.arity = arity;
    key.nodes = nodes;
    std::sort(key.nodes.begin(), key.nodes.begin() + arity);
    return key;
}

void register_face(
    std::map<FaceKey, FaceOwners> &faces,
    const std::array<std::uint32_t, 4> &nodes,
    std::uint8_t arity,
    std::uint32_t marker)
{
    const FaceKey key = face_key(nodes, arity);
    auto &face = faces[key];
    if (face.owner_count == 0u) {
        face.nodes = nodes;
        face.arity = arity;
    }
    if (face.owner_count >= 2u) {
        fail("generated prism mesh contains a non-manifold face");
    }
    face.markers[face.owner_count++] = marker;
}

MeshBuffers build_mesh(const ProbeConfig &config)
{
    const auto x = interval_axis(
        -0.5 * kAirboxX,
        -0.5 * kFilmX,
        0.5 * kFilmX,
        0.5 * kAirboxX,
        config.outer_x_intervals_per_side,
        config.film_x_intervals,
        config.outer_x_intervals_per_side);
    const auto y = interval_axis(
        -0.5 * kAirboxY,
        -0.5 * kFilmY,
        0.5 * kFilmY,
        0.5 * kAirboxY,
        config.outer_y_intervals_per_side,
        config.film_y_intervals,
        config.outer_y_intervals_per_side);
    const auto z = interval_axis(
        -0.5 * kAirboxZ,
        -0.5 * kFilmZ,
        0.5 * kFilmZ,
        0.5 * kAirboxZ,
        config.outer_z_intervals_per_side,
        config.film_layers,
        config.outer_z_intervals_per_side);

    const std::uint32_t nx = static_cast<std::uint32_t>(x.size() - 1u);
    const std::uint32_t ny = static_cast<std::uint32_t>(y.size() - 1u);
    const std::uint32_t nz = static_cast<std::uint32_t>(z.size() - 1u);
    const std::uint64_t node_count =
        static_cast<std::uint64_t>(nx + 1u) * (ny + 1u) * (nz + 1u);
    const std::uint64_t cell_count =
        2u * static_cast<std::uint64_t>(nx) * ny * nz;
    if (node_count > std::numeric_limits<std::uint32_t>::max() ||
        cell_count > std::numeric_limits<std::uint32_t>::max()) {
        fail("requested prism mesh exceeds the native uint32 topology range");
    }

    MeshBuffers mesh{};
    mesh.nodes_xyz.reserve(static_cast<std::size_t>(3u * node_count));
    mesh.cell_types.reserve(static_cast<std::size_t>(cell_count));
    mesh.cell_offsets.reserve(static_cast<std::size_t>(cell_count + 1u));
    mesh.cell_nodes.reserve(static_cast<std::size_t>(6u * cell_count));
    mesh.cell_global_ordinals.reserve(static_cast<std::size_t>(cell_count));
    mesh.cell_markers.reserve(static_cast<std::size_t>(cell_count));
    mesh.initial_m.reserve(static_cast<std::size_t>(3u * node_count));

    const auto node = [nx, ny](std::uint32_t i, std::uint32_t j, std::uint32_t k) {
        return i + (nx + 1u) * (j + (ny + 1u) * k);
    };
    const double initial_norm = std::sqrt(1.01);
    for (std::uint32_t k = 0u; k <= nz; ++k) {
        for (std::uint32_t j = 0u; j <= ny; ++j) {
            for (std::uint32_t i = 0u; i <= nx; ++i) {
                mesh.nodes_xyz.push_back(x[i]);
                mesh.nodes_xyz.push_back(y[j]);
                mesh.nodes_xyz.push_back(z[k]);
                mesh.initial_m.push_back(1.0 / initial_norm);
                mesh.initial_m.push_back(0.1 / initial_norm);
                mesh.initial_m.push_back(0.0);
            }
        }
    }

    std::map<FaceKey, FaceOwners> faces;
    mesh.cell_offsets.push_back(0u);
    const auto append_prism = [&mesh, &faces](
                                  const std::array<std::uint32_t, 6> &vertices,
                                  std::uint32_t marker) {
        const std::uint64_t ordinal = mesh.cell_types.size();
        mesh.cell_types.push_back(FULLMAG_FEM_CELL_PRISM6);
        mesh.cell_nodes.insert(mesh.cell_nodes.end(), vertices.begin(), vertices.end());
        mesh.cell_offsets.push_back(static_cast<std::uint32_t>(mesh.cell_nodes.size()));
        mesh.cell_global_ordinals.push_back(ordinal);
        mesh.cell_markers.push_back(marker);
        if (marker == kFilmMarker) {
            ++mesh.magnetic_cell_count;
        }
        register_face(faces, {{vertices[0], vertices[1], vertices[2], 0u}}, 3u, marker);
        register_face(faces, {{vertices[3], vertices[4], vertices[5], 0u}}, 3u, marker);
        register_face(faces, {{vertices[0], vertices[1], vertices[4], vertices[3]}}, 4u, marker);
        register_face(faces, {{vertices[1], vertices[2], vertices[5], vertices[4]}}, 4u, marker);
        register_face(faces, {{vertices[2], vertices[0], vertices[3], vertices[5]}}, 4u, marker);
    };

    const std::uint32_t film_i0 = config.outer_x_intervals_per_side;
    const std::uint32_t film_i1 = film_i0 + config.film_x_intervals;
    const std::uint32_t film_j0 = config.outer_y_intervals_per_side;
    const std::uint32_t film_j1 = film_j0 + config.film_y_intervals;
    const std::uint32_t film_k0 = config.outer_z_intervals_per_side;
    const std::uint32_t film_k1 = film_k0 + config.film_layers;
    for (std::uint32_t k = 0u; k < nz; ++k) {
        for (std::uint32_t j = 0u; j < ny; ++j) {
            for (std::uint32_t i = 0u; i < nx; ++i) {
                const std::uint32_t marker =
                    i >= film_i0 && i < film_i1 && j >= film_j0 && j < film_j1 &&
                        k >= film_k0 && k < film_k1
                    ? kFilmMarker
                    : 0u;
                const std::uint32_t a0 = node(i, j, k);
                const std::uint32_t b0 = node(i + 1u, j, k);
                const std::uint32_t c0 = node(i + 1u, j + 1u, k);
                const std::uint32_t d0 = node(i, j + 1u, k);
                const std::uint32_t a1 = node(i, j, k + 1u);
                const std::uint32_t b1 = node(i + 1u, j, k + 1u);
                const std::uint32_t c1 = node(i + 1u, j + 1u, k + 1u);
                const std::uint32_t d1 = node(i, j + 1u, k + 1u);
                if ((i + j) % 2u == 0u) {
                    append_prism({{a0, b0, c0, a1, b1, c1}}, marker);
                    append_prism({{a0, c0, d0, a1, c1, d1}}, marker);
                } else {
                    append_prism({{a0, b0, d0, a1, b1, d1}}, marker);
                    append_prism({{b0, c0, d0, b1, c1, d1}}, marker);
                }
            }
        }
    }

    mesh.facet_offsets.push_back(0u);
    for (const auto &[key, face] : faces) {
        std::uint32_t role = 0u;
        std::uint32_t marker = 0u;
        if (face.owner_count == 1u) {
            role = FULLMAG_FEM_FACET_ROLE_EXTERIOR;
            marker = kOuterMarker;
            ++mesh.exterior_facet_count;
        } else if (face.owner_count == 2u && face.markers[0] != face.markers[1]) {
            role = FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE;
            marker = kInterfaceMarker;
            ++mesh.interface_facet_count;
        } else {
            continue;
        }
        mesh.facet_types.push_back(
            key.arity == 3u ? FULLMAG_FEM_FACET_TRI3 : FULLMAG_FEM_FACET_QUAD4);
        mesh.facet_roles.push_back(role);
        mesh.facet_nodes.insert(
            mesh.facet_nodes.end(), face.nodes.begin(), face.nodes.begin() + key.arity);
        mesh.facet_offsets.push_back(static_cast<std::uint32_t>(mesh.facet_nodes.size()));
        mesh.facet_global_ordinals.push_back(mesh.facet_global_ordinals.size());
        mesh.facet_markers.push_back(marker);
    }
    return mesh;
}

fullmag_fem_mesh_desc descriptor(const MeshBuffers &mesh)
{
    fullmag_fem_mesh_desc desc{};
    desc.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
    desc.struct_size = sizeof(fullmag_fem_mesh_desc);
    desc.nodes_xyz = mesh.nodes_xyz.data();
    desc.nodes_xyz_len = mesh.nodes_xyz.size();
    desc.cell_types = mesh.cell_types.data();
    desc.cell_types_len = mesh.cell_types.size();
    desc.cell_offsets = mesh.cell_offsets.data();
    desc.cell_offsets_len = mesh.cell_offsets.size();
    desc.cell_nodes = mesh.cell_nodes.data();
    desc.cell_nodes_len = mesh.cell_nodes.size();
    desc.cell_global_ordinals = mesh.cell_global_ordinals.data();
    desc.cell_global_ordinals_len = mesh.cell_global_ordinals.size();
    desc.cell_markers = mesh.cell_markers.data();
    desc.cell_markers_len = mesh.cell_markers.size();
    desc.facet_types = mesh.facet_types.data();
    desc.facet_types_len = mesh.facet_types.size();
    desc.facet_roles = mesh.facet_roles.data();
    desc.facet_roles_len = mesh.facet_roles.size();
    desc.facet_offsets = mesh.facet_offsets.data();
    desc.facet_offsets_len = mesh.facet_offsets.size();
    desc.facet_nodes = mesh.facet_nodes.data();
    desc.facet_nodes_len = mesh.facet_nodes.size();
    desc.facet_global_ordinals = mesh.facet_global_ordinals.data();
    desc.facet_global_ordinals_len = mesh.facet_global_ordinals.size();
    desc.facet_markers = mesh.facet_markers.data();
    desc.facet_markers_len = mesh.facet_markers.size();
    return desc;
}

fullmag_fem_plan_desc make_plan(const MeshBuffers &mesh)
{
    fullmag_fem_plan_desc plan{};
    plan.mesh = descriptor(mesh);
    plan.material.saturation_magnetisation = kMs;
    plan.material.exchange_stiffness = kAex;
    plan.material.damping = kAlpha;
    plan.material.gyromagnetic_ratio = kGammaMu0;
    plan.fe_order = 1u;
    plan.hmax = 20.0e-9;
    plan.precision = FULLMAG_FEM_PRECISION_DOUBLE;
    plan.integrator = FULLMAG_FEM_INTEGRATOR_HEUN;
    plan.enable_exchange = 1;
    plan.enable_demag = 1;
    plan.demag_solver.solver = FULLMAG_FEM_LINEAR_SOLVER_CG;
    plan.demag_solver.preconditioner = FULLMAG_FEM_PRECONDITIONER_AMG;
    plan.demag_solver.relative_tolerance = 1.0e-12;
    plan.demag_solver.max_iterations = 500u;
    plan.air_box_factor = 1.0;
    plan.demag_realization = FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
    plan.poisson_boundary_marker = static_cast<int>(kOuterMarker);
    plan.robin_beta_mode = 2;
    plan.robin_beta_factor = 2.0;
    plan.initial_magnetization_xyz = mesh.initial_m.data();
    plan.initial_magnetization_len = mesh.initial_m.size();
    plan.dt_seconds = 1.0e-15;
    plan.gpu_device_index = -1;
    plan.mfem_device_string = "cpu";
    plan.use_consistent_mass = 1;
    plan.eager_initial_effective_field = 1;
    return plan;
}

std::string last_error(fullmag_fem_backend *backend)
{
    const char *message = fullmag_fem_backend_last_error(backend);
    return message == nullptr ? "unknown native FEM error" : message;
}

void print_stats(
    const char *kind,
    std::uint64_t relaxation_step,
    const fullmag_fem_step_stats &stats)
{
    std::cout << std::setprecision(17)
              << "{\"record\":\"" << kind << "\""
              << ",\"relaxation_step\":" << relaxation_step
              << ",\"mx\":" << stats.mx
              << ",\"my\":" << stats.my
              << ",\"mz\":" << stats.mz
              << ",\"exchange_energy_j\":" << stats.exchange_energy_joules
              << ",\"demag_energy_j\":" << stats.demag_energy_joules
              << ",\"total_energy_j\":" << stats.total_energy_joules
              << ",\"demag_vs_fdm_relative\":"
              << (stats.demag_energy_joules - kFdmInitialDemagJ) / kFdmInitialDemagJ
              << ",\"max_torque_apm\":" << stats.max_torque_Apm
              << ",\"max_h_demag_apm\":" << stats.max_demag_field_amplitude
              << ",\"demag_potential_order\":" << stats.demag_potential_order
              << ",\"demag_potential_true_dofs\":"
              << stats.demag_potential_true_dof_count
              << ",\"demag_iterations\":" << stats.demag_linear_iterations
              << ",\"demag_residual\":" << stats.demag_linear_residual
              << ",\"demag_variational_energy_j\":"
              << stats.demag_variational_energy_joules
              << ",\"demag_recovered_field_energy_j\":"
              << stats.demag_recovered_field_energy_joules << "}\n";
}

int run(const ProbeConfig &config)
{
    MeshBuffers mesh = build_mesh(config);
    std::cout << "{\"record\":\"mesh\""
              << ",\"topology\":\"prism6\""
              << ",\"film_layers\":" << config.film_layers
              << ",\"film_nx\":" << config.film_x_intervals
              << ",\"film_ny\":" << config.film_y_intervals
              << ",\"outer_growth\":" << kOuterGrowth
              << ",\"nodes\":" << mesh.nodes_xyz.size() / 3u
              << ",\"cells\":" << mesh.cell_types.size()
              << ",\"magnetic_cells\":" << mesh.magnetic_cell_count
              << ",\"exterior_facets\":" << mesh.exterior_facet_count
              << ",\"interface_facets\":" << mesh.interface_facet_count << "}\n";

    fullmag_fem_plan_desc plan = make_plan(mesh);
    fullmag_fem_backend *backend = fullmag_fem_backend_create(&plan);
    if (backend == nullptr) {
        fail("native backend creation failed: " + last_error(nullptr));
    }

    fullmag_fem_step_stats stats{};
    if (fullmag_fem_backend_snapshot_stats(backend, &stats) != FULLMAG_FEM_OK) {
        const std::string message = last_error(backend);
        fullmag_fem_backend_destroy(backend);
        fail("initial snapshot failed: " + message);
    }
    print_stats("initial", 0u, stats);

    for (std::uint64_t step = 1u; step <= config.relaxation_steps; ++step) {
        if (fullmag_fem_backend_relax_step(
                backend, FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB, &stats) !=
            FULLMAG_FEM_OK) {
            const std::string message = last_error(backend);
            fullmag_fem_backend_destroy(backend);
            fail("relaxation step failed: " + message);
        }
        if (step == config.relaxation_steps || step % 100u == 0u) {
            print_stats("relaxation", step, stats);
        }
    }

    fullmag_fem_backend_destroy(backend);
    return 0;
}

} // namespace

int main(int argc, char **argv)
{
    try {
        return run(parse_config(argc, argv));
    } catch (const std::exception &exception) {
        std::cerr << "prism_shared_airbox_probe: " << exception.what() << '\n';
        return 1;
    }
}

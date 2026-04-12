#include "context.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <random>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kB  = 1.380649e-23;   // Boltzmann constant [J/K]
constexpr double kMU0 = 4.0 * kPi * 1e-7;  // vacuum permeability [T·m/A]
constexpr double kZeroThreshold = 1e-30; // FEM-040: named zero guard
constexpr double kOrthogonalityDotTol = 1e-3;    // cubic axis dot-product tolerance
constexpr double kOrthogonalityCrossMinNorm = 1e-6; // cubic axis cross-product minimum norm

template <typename T>
void copy_optional_span(
    const T *source,
    size_t count,
    std::vector<T> &destination,
    T fill_value = T{})
{
    destination.assign(count, fill_value);
    if (source != nullptr && count > 0) {
        std::copy(source, source + count, destination.begin());
    }
}

void fill_repeated_vector_field(
    std::vector<double> &buffer,
    uint32_t n_nodes,
    const std::array<double, 3> &value)
{
    buffer.resize(static_cast<size_t>(n_nodes) * 3u);
    for (uint32_t i = 0; i < n_nodes; ++i) {
        const size_t base = static_cast<size_t>(i) * 3u;
        buffer[base + 0] = value[0];
        buffer[base + 1] = value[1];
        buffer[base + 2] = value[2];
    }
}

void fill_zero_vector_field(std::vector<double> &buffer, uint32_t n_nodes) {
    buffer.assign(static_cast<size_t>(n_nodes) * 3u, 0.0);
}

double average_magnetic_scalar_field(
    const std::vector<double> &field,
    const std::vector<uint8_t> &magnetic_node_mask,
    double fallback)
{
    if (field.empty()) {
        return fallback;
    }

    double sum = 0.0;
    size_t count = 0;
    const size_t node_count = std::min(field.size(), magnetic_node_mask.size());
    for (size_t node = 0; node < node_count; ++node) {
        if (magnetic_node_mask[node] == 0u) {
            continue;
        }
        sum += field[node];
        count += 1;
    }
    if (count == 0) {
        return fallback;
    }
    return sum / static_cast<double>(count);
}

double tetrahedron_volume(
    const std::vector<double> &nodes_xyz,
    const std::vector<uint32_t> &elements,
    uint32_t element_index)
{
    const size_t base = static_cast<size_t>(element_index) * 4u;
    const auto read_coord = [&](uint32_t node, int axis) -> double {
        return nodes_xyz[static_cast<size_t>(node) * 3u + static_cast<size_t>(axis)];
    };

    const uint32_t n0 = elements[base + 0];
    const uint32_t n1 = elements[base + 1];
    const uint32_t n2 = elements[base + 2];
    const uint32_t n3 = elements[base + 3];

    const double ax = read_coord(n1, 0) - read_coord(n0, 0);
    const double ay = read_coord(n1, 1) - read_coord(n0, 1);
    const double az = read_coord(n1, 2) - read_coord(n0, 2);
    const double bx = read_coord(n2, 0) - read_coord(n0, 0);
    const double by = read_coord(n2, 1) - read_coord(n0, 1);
    const double bz = read_coord(n2, 2) - read_coord(n0, 2);
    const double cx = read_coord(n3, 0) - read_coord(n0, 0);
    const double cy = read_coord(n3, 1) - read_coord(n0, 1);
    const double cz = read_coord(n3, 2) - read_coord(n0, 2);

    const double determinant =
        ax * (by * cz - bz * cy) -
        ay * (bx * cz - bz * cx) +
        az * (bx * cy - by * cx);

    return std::abs(determinant) / 6.0;
}

double average_magnetic_node_volume(const Context &ctx) {
    size_t magnetic_node_count = 0;
    for (uint8_t magnetic : ctx.magnetic_node_mask) {
        if (magnetic != 0u) {
            magnetic_node_count += 1;
        }
    }
    if (magnetic_node_count == 0) {
        return 0.0;
    }

    double total_magnetic_volume = 0.0;
    for (uint32_t element = 0; element < ctx.n_elements; ++element) {
        if (!ctx.magnetic_element_mask.empty() &&
            ctx.magnetic_element_mask[static_cast<size_t>(element)] == 0u) {
            continue;
        }
        total_magnetic_volume += tetrahedron_volume(ctx.nodes_xyz, ctx.elements, element);
    }
    if (total_magnetic_volume <= 0.0) {
        return 0.0;
    }
    return total_magnetic_volume / static_cast<double>(magnetic_node_count);
}

/// Compute per-node dual volume: each node receives 1/4 of the volume of every
/// magnetic tetrahedron it belongs to (P1 lumped-mass semantics).
void compute_node_volumes(Context &ctx) {
    const size_t n = static_cast<size_t>(ctx.n_nodes);
    ctx.node_volumes.assign(n, 0.0);

    for (uint32_t elem = 0; elem < ctx.n_elements; ++elem) {
        if (!ctx.magnetic_element_mask.empty() &&
            ctx.magnetic_element_mask[static_cast<size_t>(elem)] == 0u) {
            continue;
        }
        const double v_tet = tetrahedron_volume(ctx.nodes_xyz, ctx.elements, elem);
        const double quarter_v = v_tet * 0.25;
        const size_t base = static_cast<size_t>(elem) * 4u;
        for (int k = 0; k < 4; ++k) {
            const uint32_t node = ctx.elements[base + static_cast<size_t>(k)];
            ctx.node_volumes[node] += quarter_v;
        }
    }
}

void refresh_thermal_field_for_current_state(Context &ctx) {
    if (ctx.h_therm_xyz.size() != static_cast<size_t>(ctx.n_nodes) * 3u) {
        ctx.h_therm_xyz.assign(static_cast<size_t>(ctx.n_nodes) * 3u, 0.0);
    }
    if (ctx.temperature <= 0.0 || ctx.current_dt <= 0.0) {
        ctx.thermal_sigma = 0.0;
        std::fill(ctx.h_therm_xyz.begin(), ctx.h_therm_xyz.end(), 0.0);
        return;
    }
    if (ctx.last_thermal_refresh_time == ctx.current_time &&
        ctx.last_thermal_refresh_dt == ctx.current_dt) {
        return;
    }

    const double gamma_red = ctx.material.gyromagnetic_ratio;
    // Use per-node dual volumes for correct local noise scaling on
    // non-uniform meshes.  Fall back to average only if the per-node
    // vector was not computed (should not happen in normal flow).
    const bool has_per_node_vol = !ctx.node_volumes.empty();
    const double V_avg = has_per_node_vol ? 0.0 : average_magnetic_node_volume(ctx);

    if (!(gamma_red > 0.0) || (!has_per_node_vol && !(V_avg > 0.0))) {
        ctx.thermal_sigma = 0.0;
        std::fill(ctx.h_therm_xyz.begin(), ctx.h_therm_xyz.end(), 0.0);
        ctx.last_thermal_refresh_time = ctx.current_time;
        ctx.last_thermal_refresh_dt = ctx.current_dt;
        return;
    }

    // FND-008 fix: per-node thermal sigma using local alpha_i and Ms_i
    // instead of mesh-averaged values.  ctx.thermal_sigma stores the
    // maximum sigma across nodes for diagnostic purposes.
    const bool has_per_node_alpha = !ctx.alpha_field.empty();
    const bool has_per_node_ms    = !ctx.Ms_field.empty();

    // Seed policy: 0 = system entropy (non-reproducible),
    // otherwise use the provided seed for reproducible stochastic runs.
    static thread_local bool rng_initialized = false;
    static thread_local uint64_t rng_active_seed = 0;
    static thread_local std::mt19937_64 rng;
    if (!rng_initialized || rng_active_seed != ctx.thermal_seed) {
        if (ctx.thermal_seed != 0) {
            rng.seed(ctx.thermal_seed);
        } else {
            std::random_device rd;
            rng.seed(rd());
        }
        rng_active_seed = ctx.thermal_seed;
        rng_initialized = true;
    }

    double max_sigma = 0.0;
    std::normal_distribution<double> unit_normal(0.0, 1.0);
    for (size_t node = 0; node < static_cast<size_t>(ctx.n_nodes); ++node) {
        const size_t base = node * 3u;
        if (!ctx.magnetic_node_mask.empty() && ctx.magnetic_node_mask[node] == 0u) {
            ctx.h_therm_xyz[base + 0] = 0.0;
            ctx.h_therm_xyz[base + 1] = 0.0;
            ctx.h_therm_xyz[base + 2] = 0.0;
            continue;
        }

        const double alpha_i = has_per_node_alpha
            ? ctx.alpha_field[node]
            : ctx.material.damping;
        const double Ms_i = has_per_node_ms
            ? ctx.Ms_field[node]
            : ctx.material.saturation_magnetisation;

        if (!(alpha_i > 0.0) || !(Ms_i > 0.0)) {
            ctx.h_therm_xyz[base + 0] = 0.0;
            ctx.h_therm_xyz[base + 1] = 0.0;
            ctx.h_therm_xyz[base + 2] = 0.0;
            continue;
        }

        const double gamma0_i = gamma_red * (1.0 + alpha_i * alpha_i);
        const double V_i = has_per_node_vol ? ctx.node_volumes[node] : V_avg;
        if (!(V_i > 0.0)) {
            ctx.h_therm_xyz[base + 0] = 0.0;
            ctx.h_therm_xyz[base + 1] = 0.0;
            ctx.h_therm_xyz[base + 2] = 0.0;
            continue;
        }
        const double sigma_i = std::sqrt(
            2.0 * alpha_i * kB * ctx.temperature /
            (gamma0_i * kMU0 * Ms_i * V_i * ctx.current_dt)
        );
        if (sigma_i > max_sigma) max_sigma = sigma_i;

        ctx.h_therm_xyz[base + 0] = unit_normal(rng) * sigma_i;
        ctx.h_therm_xyz[base + 1] = unit_normal(rng) * sigma_i;
        ctx.h_therm_xyz[base + 2] = unit_normal(rng) * sigma_i;
    }
    ctx.thermal_sigma = max_sigma;
    ctx.last_thermal_refresh_time = ctx.current_time;
    ctx.last_thermal_refresh_dt = ctx.current_dt;
}

} // namespace

void context_refresh_thermal_field(Context &ctx) {
    refresh_thermal_field_for_current_state(ctx);
}

bool context_from_plan(Context &ctx, const fullmag_fem_plan_desc &plan, std::string &error) {
    if (plan.mesh.n_nodes == 0) {
        error = "FEM mesh must contain at least one node";
        return false;
    }
    if (plan.mesh.n_elements == 0) {
        error = "FEM mesh must contain at least one tetrahedral element";
        return false;
    }
    if (plan.mesh.nodes_xyz == nullptr) {
        error = "FEM mesh nodes pointer is null";
        return false;
    }
    if (plan.mesh.elements == nullptr) {
        error = "FEM mesh elements pointer is null";
        return false;
    }
    if (plan.initial_magnetization_xyz == nullptr) {
        error = "initial magnetization pointer is null";
        return false;
    }

    const uint64_t expected_m_len = static_cast<uint64_t>(plan.mesh.n_nodes) * 3ull;
    if (plan.initial_magnetization_len != expected_m_len) {
        error = "initial magnetization length mismatch";
        return false;
    }
    if (plan.dt_seconds <= 0.0) {
        error = "FEM time step must be positive";
        return false;
    }

    ctx.n_nodes = plan.mesh.n_nodes;
    ctx.n_elements = plan.mesh.n_elements;
    ctx.n_boundary_faces = plan.mesh.n_boundary_faces;
    ctx.fe_order = plan.fe_order;
    ctx.hmax = plan.hmax;
    ctx.dt_seconds = plan.dt_seconds;
    ctx.current_dt = plan.dt_seconds;
    ctx.air_box_factor = plan.air_box_factor;
    ctx.precision = plan.precision;
    ctx.integrator = plan.integrator;
    ctx.enable_exchange = plan.enable_exchange != 0;
    ctx.enable_demag = plan.enable_demag != 0;
    ctx.has_external_field = plan.has_external_field != 0;
    ctx.external_field_am = {
        plan.external_field_am[0],
        plan.external_field_am[1],
        plan.external_field_am[2],
    };
    ctx.enable_anisotropy = plan.has_uniaxial_anisotropy != 0;
    ctx.anisotropy_Ku = plan.uniaxial_anisotropy_constant;
    ctx.anisotropy_Ku2 = plan.uniaxial_anisotropy_k2;
    ctx.anisotropy_axis = {
        plan.anisotropy_axis[0],
        plan.anisotropy_axis[1],
        plan.anisotropy_axis[2],
    };
    ctx.enable_dmi = plan.has_interfacial_dmi != 0;
    ctx.dmi_D = plan.dmi_constant;
    // FND-009: read interface normal, default to ẑ if zero-length
    {
        double nx = plan.dmi_interface_normal[0];
        double ny = plan.dmi_interface_normal[1];
        double nz = plan.dmi_interface_normal[2];
        double len = std::sqrt(nx*nx + ny*ny + nz*nz);
        if (len > 1e-15) {
            ctx.dmi_n_hat = {nx/len, ny/len, nz/len};
        } else {
            ctx.dmi_n_hat = {0.0, 0.0, 1.0};
        }
    }
    ctx.enable_bulk_dmi = plan.has_bulk_dmi != 0;
    ctx.bulk_dmi_D = plan.bulk_dmi_constant;
    ctx.enable_cubic_anisotropy = plan.has_cubic_anisotropy != 0;
    ctx.cubic_Kc1 = plan.cubic_kc1;
    ctx.cubic_Kc2 = plan.cubic_kc2;
    ctx.cubic_Kc3 = plan.cubic_kc3;
    ctx.cubic_axis1 = {plan.cubic_axis1[0], plan.cubic_axis1[1], plan.cubic_axis1[2]};
    ctx.cubic_axis2 = {plan.cubic_axis2[0], plan.cubic_axis2[1], plan.cubic_axis2[2]};
    ctx.material = plan.material;
    ctx.demag_solver = plan.demag_solver;

    // Copy per-node spatially varying fields
    auto copy_field = [](std::vector<double> &dst, const double *src, uint64_t len) {
        if (src != nullptr && len > 0) {
            dst.assign(src, src + len);
        }
    };
    copy_field(ctx.Ms_field,    plan.ms_field,    plan.ms_field_len);
    copy_field(ctx.A_field,     plan.a_field,     plan.a_field_len);
    copy_field(ctx.alpha_field, plan.alpha_field,  plan.alpha_field_len);
    copy_field(ctx.Ku_field,    plan.ku_field,    plan.ku_field_len);
    copy_field(ctx.Ku2_field,   plan.ku2_field,   plan.ku2_field_len);
    copy_field(ctx.Dind_field,  plan.dind_field,  plan.dind_field_len);
    copy_field(ctx.Dbulk_field, plan.dbulk_field, plan.dbulk_field_len);
    copy_field(ctx.Kc1_field,   plan.kc1_field,   plan.kc1_field_len);
    copy_field(ctx.Kc2_field,   plan.kc2_field,   plan.kc2_field_len);
    copy_field(ctx.Kc3_field,   plan.kc3_field,   plan.kc3_field_len);

    // F-14 fix: validate per-node field lengths match n_nodes.
    {
        auto check_field_len = [&](const std::vector<double> &field, const char *name) -> bool {
            if (!field.empty() && field.size() != static_cast<size_t>(ctx.n_nodes)) {
                error = std::string("per-node field '") + name + "' has length " +
                        std::to_string(field.size()) + " but n_nodes=" +
                        std::to_string(ctx.n_nodes);
                return false;
            }
            return true;
        };
        if (!check_field_len(ctx.Ms_field, "Ms_field") ||
            !check_field_len(ctx.A_field, "A_field") ||
            !check_field_len(ctx.alpha_field, "alpha_field") ||
            !check_field_len(ctx.Ku_field, "Ku_field") ||
            !check_field_len(ctx.Ku2_field, "Ku2_field") ||
            !check_field_len(ctx.Dind_field, "Dind_field") ||
            !check_field_len(ctx.Dbulk_field, "Dbulk_field") ||
            !check_field_len(ctx.Kc1_field, "Kc1_field") ||
            !check_field_len(ctx.Kc2_field, "Kc2_field") ||
            !check_field_len(ctx.Kc3_field, "Kc3_field")) {
            return false;
        }
        auto validate_field_values = [&](const std::vector<double> &field, const char *name,
                                         bool require_positive, bool allow_zero) -> bool {
            for (size_t i = 0; i < field.size(); ++i) {
                const double value = field[i];
                if (!std::isfinite(value)) {
                    error = std::string("per-node field '") + name +
                            "' contains NaN/Inf at index " + std::to_string(i);
                    return false;
                }
                if (require_positive) {
                    const bool valid = allow_zero ? value >= 0.0 : value > 0.0;
                    if (!valid) {
                        error = std::string("per-node field '") + name +
                                "' contains invalid value " + std::to_string(value) +
                                " at index " + std::to_string(i);
                        return false;
                    }
                }
            }
            return true;
        };
        if (!validate_field_values(ctx.Ms_field, "Ms_field", true, false) ||
            !validate_field_values(ctx.A_field, "A_field", true, true) ||
            !validate_field_values(ctx.alpha_field, "alpha_field", true, true) ||
            !validate_field_values(ctx.Ku_field, "Ku_field", false, true) ||
            !validate_field_values(ctx.Ku2_field, "Ku2_field", false, true) ||
            !validate_field_values(ctx.Dind_field, "Dind_field", false, true) ||
            !validate_field_values(ctx.Dbulk_field, "Dbulk_field", false, true) ||
            !validate_field_values(ctx.Kc1_field, "Kc1_field", false, true) ||
            !validate_field_values(ctx.Kc2_field, "Kc2_field", false, true) ||
            !validate_field_values(ctx.Kc3_field, "Kc3_field", false, true)) {
            return false;
        }
        if (!std::isfinite(ctx.material.saturation_magnetisation) ||
            ctx.material.saturation_magnetisation <= 0.0) {
            error = "material.saturation_magnetisation must be finite and > 0";
            return false;
        }
        if (!std::isfinite(ctx.material.exchange_stiffness) ||
            ctx.material.exchange_stiffness < 0.0) {
            error = "material.exchange_stiffness must be finite and >= 0";
            return false;
        }
        if (!std::isfinite(ctx.material.damping) || ctx.material.damping < 0.0) {
            error = "material.damping must be finite and >= 0";
            return false;
        }
    }

    // F-14 fix: normalize anisotropy axes.
    {
        auto normalize3 = [](std::array<double, 3> &v) {
            double len = std::sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
            if (len > kZeroThreshold) {
                v[0] /= len; v[1] /= len; v[2] /= len;
            }
        };
        if (ctx.enable_anisotropy) {
            normalize3(ctx.anisotropy_axis);
        }
        if (ctx.enable_cubic_anisotropy) {
            normalize3(ctx.cubic_axis1);
            normalize3(ctx.cubic_axis2);
            const double dot =
                ctx.cubic_axis1[0] * ctx.cubic_axis2[0] +
                ctx.cubic_axis1[1] * ctx.cubic_axis2[1] +
                ctx.cubic_axis1[2] * ctx.cubic_axis2[2];
            const double cross_x =
                ctx.cubic_axis1[1] * ctx.cubic_axis2[2] -
                ctx.cubic_axis1[2] * ctx.cubic_axis2[1];
            const double cross_y =
                ctx.cubic_axis1[2] * ctx.cubic_axis2[0] -
                ctx.cubic_axis1[0] * ctx.cubic_axis2[2];
            const double cross_z =
                ctx.cubic_axis1[0] * ctx.cubic_axis2[1] -
                ctx.cubic_axis1[1] * ctx.cubic_axis2[0];
            const double cross_norm = std::sqrt(cross_x * cross_x + cross_y * cross_y + cross_z * cross_z);
            if (!std::isfinite(dot) || !std::isfinite(cross_norm) ||
                std::abs(dot) > kOrthogonalityDotTol || cross_norm < kOrthogonalityCrossMinNorm) {
                error = "cubic anisotropy axes must be finite, normalized and mutually orthogonal";
                return false;
            }
        }
    }

    // Adaptive time-stepping from plan
    if (plan.adaptive_config != nullptr) {
        ctx.adaptive_dt_enabled = true;
        ctx.adaptive_atol = plan.adaptive_config->atol;
        ctx.adaptive_rtol = plan.adaptive_config->rtol;
        ctx.dt_seconds = plan.adaptive_config->dt_initial > 0.0
                             ? plan.adaptive_config->dt_initial
                             : plan.dt_seconds;
        ctx.current_dt = ctx.dt_seconds;
        ctx.dt_min = plan.adaptive_config->dt_min;
        ctx.dt_max = plan.adaptive_config->dt_max;
        ctx.safety_factor = plan.adaptive_config->safety;
        ctx.dt_grow_max = plan.adaptive_config->growth_limit;
        ctx.dt_shrink_min = plan.adaptive_config->shrink_limit;
    }

#if FULLMAG_HAS_MFEM_STACK
    ctx.demag_realization = static_cast<int>(plan.demag_realization);
    ctx.poisson_boundary_marker = plan.poisson_boundary_marker;
    ctx.robin_beta_mode = plan.robin_beta_mode;
    ctx.robin_beta_factor = plan.robin_beta_factor;
#endif
    ctx.step_count = 0;
    ctx.current_time = 0.0;

    ctx.nodes_xyz.assign(
        plan.mesh.nodes_xyz,
        plan.mesh.nodes_xyz + static_cast<size_t>(ctx.n_nodes) * 3u);
    ctx.elements.assign(
        plan.mesh.elements,
        plan.mesh.elements + static_cast<size_t>(ctx.n_elements) * 4u);
    copy_optional_span(
        plan.mesh.element_markers,
        static_cast<size_t>(ctx.n_elements),
        ctx.element_markers,
        0u);
    copy_optional_span(
        plan.mesh.boundary_faces,
        static_cast<size_t>(ctx.n_boundary_faces) * 3u,
        ctx.boundary_faces,
        0u);
    copy_optional_span(
        plan.mesh.boundary_markers,
        static_cast<size_t>(ctx.n_boundary_faces),
        ctx.boundary_markers,
        0u);

    ctx.m_xyz.assign(
        plan.initial_magnetization_xyz,
        plan.initial_magnetization_xyz + static_cast<size_t>(plan.initial_magnetization_len));

    // Only copy Newell kernel spectra for transfer-grid demag (not poisson_airbox).
    if (static_cast<int>(plan.demag_realization) == 0 /* TRANSFER_GRID */) {
        copy_optional_span(
            plan.demag_kernel_xx_spectrum,
            static_cast<size_t>(plan.demag_kernel_spectrum_len),
            ctx.transfer_grid.kernel_xx_spectrum,
            0.0);
        copy_optional_span(
            plan.demag_kernel_yy_spectrum,
            static_cast<size_t>(plan.demag_kernel_spectrum_len),
            ctx.transfer_grid.kernel_yy_spectrum,
            0.0);
        copy_optional_span(
            plan.demag_kernel_zz_spectrum,
            static_cast<size_t>(plan.demag_kernel_spectrum_len),
            ctx.transfer_grid.kernel_zz_spectrum,
            0.0);
        copy_optional_span(
            plan.demag_kernel_xy_spectrum,
            static_cast<size_t>(plan.demag_kernel_spectrum_len),
            ctx.transfer_grid.kernel_xy_spectrum,
            0.0);
        copy_optional_span(
            plan.demag_kernel_xz_spectrum,
            static_cast<size_t>(plan.demag_kernel_spectrum_len),
            ctx.transfer_grid.kernel_xz_spectrum,
            0.0);
        copy_optional_span(
            plan.demag_kernel_yz_spectrum,
            static_cast<size_t>(plan.demag_kernel_spectrum_len),
            ctx.transfer_grid.kernel_yz_spectrum,
            0.0);
    }
    // Build magnetic element mask to match the shared Rust FEM contract:
    // - mixed 0/non-zero markers => non-zero markers are magnetic, 0 is air,
    // - all-zero markers => treat the whole mesh as magnetic,
    // - all-nonzero markers => treat the whole mesh as magnetic.
    {
        ctx.magnetic_element_mask.assign(static_cast<size_t>(ctx.n_elements), 1u);
        if (!ctx.element_markers.empty()) {
            bool has_air = false;
            bool has_magnetic = false;
            for (size_t i = 0; i < ctx.element_markers.size(); ++i) {
                has_air = has_air || ctx.element_markers[i] == 0u;
                has_magnetic = has_magnetic || ctx.element_markers[i] != 0u;
            }
            if (has_air && has_magnetic) {
                for (size_t i = 0; i < ctx.element_markers.size(); ++i) {
                    ctx.magnetic_element_mask[i] =
                        ctx.element_markers[i] != 0u ? 1u : 0u;
                }
            }
        }
        // Build per-node mask: a node is magnetic if it belongs to at least
        // one magnetic element.
        ctx.magnetic_node_mask.assign(static_cast<size_t>(ctx.n_nodes), 0u);
        for (uint32_t e = 0; e < ctx.n_elements; ++e) {
            if (ctx.magnetic_element_mask[e] == 0u) {
                continue;
            }
            const size_t base = static_cast<size_t>(e) * 4u;
            for (int v = 0; v < 4; ++v) {
                ctx.magnetic_node_mask[ctx.elements[base + v]] = 1u;
            }
        }
    }

    fill_zero_vector_field(ctx.h_ex_xyz, ctx.n_nodes);
    fill_zero_vector_field(ctx.h_demag_xyz, ctx.n_nodes);
    fill_zero_vector_field(ctx.h_ani_xyz, ctx.n_nodes);
    fill_zero_vector_field(ctx.h_dmi_xyz, ctx.n_nodes);

    // Precompute per-node dual volumes for thermal noise (must come after
    // magnetic_element_mask and elements are populated).
    compute_node_volumes(ctx);

    if (ctx.has_external_field) {
        fill_repeated_vector_field(ctx.h_ext_xyz, ctx.n_nodes, ctx.external_field_am);
        ctx.h_eff_xyz = ctx.h_ext_xyz;
    } else {
        fill_zero_vector_field(ctx.h_ext_xyz, ctx.n_nodes);
        fill_zero_vector_field(ctx.h_eff_xyz, ctx.n_nodes);
    }

    // ── Oersted field (cylindrical conductor) ──
    ctx.has_oersted_cylinder = plan.has_oersted_cylinder != 0;
    ctx.oersted_current = plan.oersted_current;
    ctx.oersted_radius = plan.oersted_radius;
    for (int i = 0; i < 3; ++i) {
        ctx.oersted_center[i] = plan.oersted_center[i];
        ctx.oersted_axis[i] = plan.oersted_axis[i];
    }
    if (ctx.has_oersted_cylinder) {
        const double axis_norm = std::sqrt(
            ctx.oersted_axis[0] * ctx.oersted_axis[0] +
            ctx.oersted_axis[1] * ctx.oersted_axis[1] +
            ctx.oersted_axis[2] * ctx.oersted_axis[2]);
        if (!(axis_norm > kZeroThreshold) || !std::isfinite(axis_norm)) {
            error = "oersted_axis must be finite and non-zero";
            return false;
        }
        for (double &value : ctx.oersted_axis) {
            value /= axis_norm;
        }
        // Arbitrary axis is now supported – no +Z restriction.
    }
    ctx.oersted_time_dep_kind = plan.oersted_time_dep_kind;
    ctx.oersted_time_dep_freq = plan.oersted_time_dep_freq;
    ctx.oersted_time_dep_phase = plan.oersted_time_dep_phase;
    ctx.oersted_time_dep_offset = plan.oersted_time_dep_offset;
    ctx.oersted_time_dep_t_on = plan.oersted_time_dep_t_on;
    ctx.oersted_time_dep_t_off = plan.oersted_time_dep_t_off;

    if (ctx.has_oersted_cylinder && ctx.oersted_radius > 0.0) {
        // Precompute static Oersted field for I = 1 A on FEM node coordinates.
        // Ampère's law for infinite cylinder along arbitrary axis â:
        //   inside  (r_perp < R):  |H| = r_perp / (2π R²)
        //   outside (r_perp >= R): |H| = 1 / (2π r_perp)
        // Direction: H = |H| * (â × r̂_perp), where r̂_perp is the unit radial vector
        // perpendicular to the axis.
        const double inv_2pi = 1.0 / (2.0 * kPi);
        const double R = ctx.oersted_radius;
        const double R2 = R * R;
        const double cx = ctx.oersted_center[0];
        const double cy = ctx.oersted_center[1];
        const double cz = ctx.oersted_center[2];
        const double ax = ctx.oersted_axis[0];
        const double ay = ctx.oersted_axis[1];
        const double az = ctx.oersted_axis[2];

        ctx.h_oe_xyz.resize(static_cast<size_t>(ctx.n_nodes) * 3u, 0.0);
        for (uint32_t i = 0; i < ctx.n_nodes; ++i) {
            const double px = ctx.nodes_xyz[i * 3 + 0] - cx;
            const double py = ctx.nodes_xyz[i * 3 + 1] - cy;
            const double pz = ctx.nodes_xyz[i * 3 + 2] - cz;

            // Project p onto axis: p_parallel = (p·â) â
            const double p_dot_a = px * ax + py * ay + pz * az;
            // Perpendicular component: r_perp = p - p_parallel
            const double rx = px - p_dot_a * ax;
            const double ry = py - p_dot_a * ay;
            const double rz = pz - p_dot_a * az;
            const double r_perp = std::sqrt(rx * rx + ry * ry + rz * rz);

            double H_mag;
            if (r_perp < kZeroThreshold) {
                H_mag = 0.0;
            } else if (r_perp < R) {
                H_mag = inv_2pi * r_perp / R2;
            } else {
                H_mag = inv_2pi / r_perp;
            }

            if (r_perp < kZeroThreshold) {
                ctx.h_oe_xyz[i * 3 + 0] = 0.0;
                ctx.h_oe_xyz[i * 3 + 1] = 0.0;
                ctx.h_oe_xyz[i * 3 + 2] = 0.0;
            } else {
                // Direction: â × r̂_perp (tangential to circle around axis)
                const double inv_r = 1.0 / r_perp;
                const double rx_hat = rx * inv_r;
                const double ry_hat = ry * inv_r;
                const double rz_hat = rz * inv_r;
                // H = H_mag * (â × r̂)
                ctx.h_oe_xyz[i * 3 + 0] = H_mag * (ay * rz_hat - az * ry_hat);
                ctx.h_oe_xyz[i * 3 + 1] = H_mag * (az * rx_hat - ax * rz_hat);
                ctx.h_oe_xyz[i * 3 + 2] = H_mag * (ax * ry_hat - ay * rx_hat);
            }
        }
    }

    // ── Thermal noise (Brown field) ──
    ctx.temperature = plan.temperature;
    if (ctx.temperature > 0.0) {
        ctx.h_therm_xyz.resize(static_cast<size_t>(ctx.n_nodes) * 3u, 0.0);
    }

    context_populate_device_info(ctx);

    // ── Magnetoelastic coupling (prescribed-strain) ──
    ctx.enable_magnetoelastic = plan.has_magnetoelastic != 0;
    ctx.mel_b1 = plan.mel_b1;
    ctx.mel_b2 = plan.mel_b2;
    ctx.mel_uniform_strain = plan.mel_uniform_strain != 0;
    if (ctx.enable_magnetoelastic && plan.mel_strain_voigt != nullptr && plan.mel_strain_len > 0) {
        ctx.mel_strain_voigt.assign(
            plan.mel_strain_voigt,
            plan.mel_strain_voigt + static_cast<size_t>(plan.mel_strain_len));
    }
    fill_zero_vector_field(ctx.h_mel_xyz, ctx.n_nodes);
    ctx.mel_energy = 0.0;

    // FEM-029 fix: read explicit GPU device index from plan (-1 = env/default).
    ctx.gpu_device_index = plan.gpu_device_index;

    // FEM-021 fix: read thermal seed from plan (0 = system entropy).
    ctx.thermal_seed = plan.thermal_seed;

    // FEM-030 fix: read explicit MFEM device string from plan.
    if (plan.mfem_device_string != nullptr && plan.mfem_device_string[0] != '\0') {
        ctx.mfem_device_string_override = plan.mfem_device_string;
    }

    // FEM-039 fix: read explicit demag transfer-grid cell size from plan.
    ctx.demag_transfer_cell_size = plan.demag_transfer_cell_size;

    // FND-013: read consistent-mass flag from plan.
    // ctx.use_consistent_mass = (plan.use_consistent_mass != 0);

#if FULLMAG_HAS_MFEM_STACK
    ctx.use_consistent_mass = (plan.use_consistent_mass != 0);
    if (!context_initialize_mfem(ctx, error)) {
        return false;
    }
    // Initialize Poisson demag solver if requested
    if (ctx.enable_demag && (ctx.demag_realization == 1 || ctx.demag_realization == 2)) {
        if (!context_initialize_poisson(ctx, error)) {
            return false;
        }
    }
    if ((ctx.enable_exchange || ctx.enable_demag) &&
        !context_refresh_exchange_field_mfem(ctx, error)) {
        return false;
    }
    context_populate_device_info(ctx);
#endif
    return true;
}

int context_copy_field_f64(
    const Context &ctx,
    fullmag_fem_observable observable,
    double *out_xyz,
    uint64_t out_len,
    std::string &error)
{
    if (out_xyz == nullptr) {
        error = "output field buffer pointer is null";
        return FULLMAG_FEM_ERR_INVALID;
    }

    const uint64_t expected_len = static_cast<uint64_t>(ctx.n_nodes) * 3ull;
    if (out_len != expected_len) {
        error = "output field length mismatch";
        return FULLMAG_FEM_ERR_INVALID;
    }

    const std::vector<double> *source = nullptr;
    switch (observable) {
        case FULLMAG_FEM_OBSERVABLE_M:
            source = &ctx.m_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_EX:
            source = &ctx.h_ex_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_DEMAG:
            // Prefer full-domain visual version (includes airbox stray field)
            // when available; fall back to LLG-zeroed version.
            source = (!ctx.h_demag_visual_xyz.empty() &&
                      ctx.h_demag_visual_xyz.size() == static_cast<size_t>(expected_len))
                         ? &ctx.h_demag_visual_xyz
                         : &ctx.h_demag_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_EXT:
            source = &ctx.h_ext_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_EFF:
            // Prefer full-domain visual version (includes airbox stray field)
            // when available; fall back to LLG-zeroed version.
            source = (!ctx.h_eff_visual_xyz.empty() &&
                      ctx.h_eff_visual_xyz.size() == static_cast<size_t>(expected_len))
                         ? &ctx.h_eff_visual_xyz
                         : &ctx.h_eff_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_ANI:
            source = &ctx.h_ani_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_DMI:
            source = &ctx.h_dmi_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_MEL:
            source = &ctx.h_mel_xyz;
            break;
        // F-12 fix: added observables for cubic anisotropy, bulk DMI, Oersted, thermal
        case FULLMAG_FEM_OBSERVABLE_H_ANI_CUBIC:
            source = &ctx.h_cubic_ani_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_DMI_BULK:
            source = &ctx.h_bulk_dmi_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_OE:
            source = &ctx.h_oe_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_THERM:
            source = &ctx.h_therm_xyz;
            break;
        default:
            error = "unsupported FEM observable";
            return FULLMAG_FEM_ERR_INVALID;
    }

    if (source == nullptr || source->size() != static_cast<size_t>(out_len)) {
        // Report an error instead of silently returning zeros when the field
        // has not been computed or has a mismatched size.
        if (source == nullptr || source->empty()) {
            error = "requested field has not been computed yet";
        } else {
            error = "field size mismatch: expected " +
                    std::to_string(out_len) + " but field has " +
                    std::to_string(source->size()) + " elements";
        }
        return FULLMAG_FEM_ERR_INVALID;
    }

    std::memcpy(out_xyz, source->data(), sizeof(double) * static_cast<size_t>(out_len));
    return FULLMAG_FEM_OK;
}

int context_upload_magnetization_f64(
    Context &ctx,
    const double *m_xyz,
    uint64_t len,
    std::string &error)
{
    if (m_xyz == nullptr) {
        error = "input magnetization pointer is null";
        return FULLMAG_FEM_ERR_INVALID;
    }

    const uint64_t expected_len = static_cast<uint64_t>(ctx.n_nodes) * 3ull;
    if (len != expected_len) {
        error = "input magnetization length mismatch";
        return FULLMAG_FEM_ERR_INVALID;
    }

    ctx.m_xyz.assign(m_xyz, m_xyz + static_cast<size_t>(len));
    ctx.stepper.fsal_valid = false;
    ctx.prev_error_norm = 1.0;

#if FULLMAG_HAS_MFEM_STACK
    // FND-004 fix: delegate H_eff assembly to compute_effective_fields_for_magnetization
    // so that all terms (exchange, demag, external, anisotropy, cubic anisotropy,
    // interfacial DMI, bulk DMI, Oersted, magnetoelastic) are included after upload.
    // Thermal noise is intentionally excluded — it is refreshed in the RHS path.
    {
        std::string heff_error;
        if (!compute_effective_fields_for_magnetization(
                ctx,
                ctx.m_xyz,
                ctx.h_ex_xyz,
                ctx.h_demag_xyz,
                ctx.h_eff_xyz,
                nullptr,   // exchange_energy — not needed on upload
                nullptr,   // demag_energy — not needed on upload
                false,     // allow_interrupt
                nullptr,   // timings
                heff_error)) {
            error = "upload_magnetization: H_eff refresh failed: " + heff_error;
            return FULLMAG_FEM_ERR_INTERNAL;
        }
    }
#else
    if (!ctx.enable_exchange) {
        fill_zero_vector_field(ctx.h_ex_xyz, ctx.n_nodes);
    }
    if (!ctx.enable_demag) {
        fill_zero_vector_field(ctx.h_demag_xyz, ctx.n_nodes);
    }
    // Non-MFEM fallback: compose H_eff from available cached fields
    if (ctx.has_external_field) {
        ctx.h_eff_xyz = ctx.h_ext_xyz;
        for (size_t i = 0; i < ctx.h_eff_xyz.size(); ++i) {
            ctx.h_eff_xyz[i] += ctx.h_ex_xyz[i] + ctx.h_demag_xyz[i];
        }
    } else {
        ctx.h_eff_xyz = ctx.h_ex_xyz;
        for (size_t i = 0; i < ctx.h_eff_xyz.size(); ++i) {
            ctx.h_eff_xyz[i] += ctx.h_demag_xyz[i];
        }
    }
#endif

    // Thermal noise is refreshed in the RHS/effective-field path, not on upload.
    ctx.thermal_sigma = 0.0;
    std::fill(ctx.h_therm_xyz.begin(), ctx.h_therm_xyz.end(), 0.0);
    ctx.last_thermal_refresh_time = -1.0;
    ctx.last_thermal_refresh_dt = -1.0;

    return FULLMAG_FEM_OK;
}

void context_populate_device_info(Context &ctx) {
    std::memset(&ctx.device_info_cache, 0, sizeof(ctx.device_info_cache));
#if FULLMAG_HAS_MFEM_STACK
    // FND-007: backend name reflects the actual demag realization in use
    std::string backend_name;
    if (ctx.mfem_exchange_ready) {
        if (!ctx.enable_demag) {
            backend_name = "mfem_cuda_exchange_ready";
        } else if (ctx.demag_realization == 0) {
            backend_name = "mfem_cuda_bootstrap_transfer_grid_demag";
        } else if (ctx.demag_realization == 1) {
            backend_name = "mfem_cuda_native_poisson_dirichlet_demag";
        } else if (ctx.demag_realization == 2) {
            backend_name = "mfem_cuda_native_poisson_robin_demag";
        } else {
            backend_name = "mfem_cuda_unknown_demag_realization";
        }
    } else if (ctx.mfem_ready) {
        backend_name = "mfem_cuda_mesh_ready";
    } else {
        backend_name = "mfem_stack_uninitialized";
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    if (ctx.mfem_selected_device_index >= 0) {
        cudaDeviceProp props{};
        int driver_version = 0;
        int runtime_version = 0;
        if (cudaGetDeviceProperties(&props, ctx.mfem_selected_device_index) == cudaSuccess) {
            backend_name = std::string(props.name);
            ctx.device_info_cache.compute_capability_major = props.major;
            ctx.device_info_cache.compute_capability_minor = props.minor;
        }
        if (cudaDriverGetVersion(&driver_version) == cudaSuccess) {
            ctx.device_info_cache.driver_version = driver_version;
        }
        if (cudaRuntimeGetVersion(&runtime_version) == cudaSuccess) {
            ctx.device_info_cache.runtime_version = runtime_version;
        }
    }
#endif
    std::strncpy(
        ctx.device_info_cache.name,
        backend_name.c_str(),
        sizeof(ctx.device_info_cache.name) - 1);
    ctx.device_info_cache.is_gpu_enabled = 1;
#else
    std::strncpy(
        ctx.device_info_cache.name,
        "native_fem_scaffold",
        sizeof(ctx.device_info_cache.name) - 1);
    ctx.device_info_cache.is_gpu_enabled = 0;
#endif
    ctx.device_info_valid = true;
}

} // namespace fullmag::fem

#if FULLMAG_HAS_MFEM_STACK
void fullmag::fem::compute_magnetoelastic_field(
    Context &ctx,
    const std::vector<double> &m_xyz)
{
    // Implements (standard convention, B₂ = −3λ₁₁₁C₄₄, tensor strain ε₁₂):
    //   H_mel,x = −(2 B₁ m_x ε₁₁ + 2 B₂ (m_y ε₁₂ + m_z ε₁₃)) / (μ₀ M_s)
    //   H_mel,y = −(2 B₁ m_y ε₂₂ + 2 B₂ (m_x ε₁₂ + m_z ε₂₃)) / (μ₀ M_s)
    //   H_mel,z = −(2 B₁ m_z ε₃₃ + 2 B₂ (m_x ε₁₃ + m_y ε₂₃)) / (μ₀ M_s)
    // Voigt: [ε₁₁, ε₂₂, ε₃₃, 2ε₂₃, 2ε₁₃, 2ε₁₂]
    constexpr double kMu0_local = 4.0e-7 * 3.14159265358979323846;
    const size_t n = ctx.n_nodes;
    ctx.h_mel_xyz.assign(n * 3u, 0.0);
    ctx.mel_energy = 0.0;

    if (!ctx.enable_magnetoelastic || ctx.mel_strain_voigt.empty()) {
        return;
    }

    const double b1 = ctx.mel_b1;
    const double b2 = ctx.mel_b2;
    const double uniform_Ms = ctx.material.saturation_magnetisation;
    double energy = 0.0;

    for (size_t i = 0; i < n; ++i) {
        if (!ctx.magnetic_node_mask.empty() && ctx.magnetic_node_mask[i] == 0u) {
            continue;
        }

        const double Ms_i = ctx.Ms_field.empty() ? uniform_Ms : ctx.Ms_field[i];
        const double inv_mu0_ms = -1.0 / (kMu0_local * Ms_i);

        // Get strain for this node
        const double *eps;
        if (ctx.mel_uniform_strain) {
            eps = ctx.mel_strain_voigt.data();  // always 6 values
        } else {
            eps = ctx.mel_strain_voigt.data() + i * 6u;  // per-node
        }
        const double e11 = eps[0];
        const double e22 = eps[1];
        const double e33 = eps[2];
        const double e23 = eps[3] * 0.5;  // engineering → tensor
        const double e13 = eps[4] * 0.5;
        const double e12 = eps[5] * 0.5;

        const size_t base = i * 3u;
        const double mx = m_xyz[base + 0];
        const double my = m_xyz[base + 1];
        const double mz = m_xyz[base + 2];

        ctx.h_mel_xyz[base + 0] = inv_mu0_ms * (2.0 * b1 * mx * e11 + 2.0 * b2 * (my * e12 + mz * e13));
        ctx.h_mel_xyz[base + 1] = inv_mu0_ms * (2.0 * b1 * my * e22 + 2.0 * b2 * (mx * e12 + mz * e23));
        ctx.h_mel_xyz[base + 2] = inv_mu0_ms * (2.0 * b1 * mz * e33 + 2.0 * b2 * (mx * e13 + my * e23));

        // Energy density: e_mel = B₁(mx²ε₁₁ + my²ε₂₂ + mz²ε₃₃) + 2B₂(mx·my·ε₁₂ + mx·mz·ε₁₃ + my·mz·ε₂₃)
        if (!ctx.mfem_lumped_mass.empty()) {
            const double e_density =
                b1 * (mx*mx*e11 + my*my*e22 + mz*mz*e33) +
                2.0 * b2 * (mx*my*e12 + mx*mz*e13 + my*mz*e23);
            energy += e_density * ctx.mfem_lumped_mass[i];
        }
    }

    ctx.mel_energy = energy;
}
#endif

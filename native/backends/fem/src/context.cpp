#include "context.hpp"
#include "core/fem_mesh.hpp"
#include "cpu/mfem/interactions/demag_fem_bem.hpp"
#include "cpu/mfem/interactions/oersted.hpp"
#include "cpu/mfem/interactions/thermal_brown.hpp"
#include "cpu/mfem/interactions/zeeman.hpp"
#include "cpu/mfem/runtime/aos_field.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

namespace {

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

} // namespace

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
    if (plan.mesh.n_periodic_node_pairs > 0 && plan.mesh.periodic_node_pairs == nullptr) {
        error = "FEM mesh periodic_node_pairs pointer is null";
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
    if (plan.fe_order != 1) {
        error = "native FEM CPU backend supports P1 tetrahedral elements only (fe_order = 1). Requested fe_order = " +
                std::to_string(plan.fe_order);
        return false;
    }
    switch (plan.integrator) {
        case FULLMAG_FEM_INTEGRATOR_HEUN:
        case FULLMAG_FEM_INTEGRATOR_RK4:
        case FULLMAG_FEM_INTEGRATOR_RK23_BS:
        case FULLMAG_FEM_INTEGRATOR_RK45_DP54:
            break;
        default:
            error = "native FEM plan requested an unsupported explicit RK integrator";
            return false;
    }
    if (plan.field_refresh.has_demag_interval_s != 0 &&
        plan.field_refresh.demag_interval_s <= 0.0) {
        error = "field_refresh.demag_interval_s must be positive when provided";
        return false;
    }
    if (plan.relax_stop.has_torque_tolerance_apm != 0 &&
        plan.relax_stop.torque_tolerance_apm <= 0.0) {
        error = "relax_stop.torque_tolerance_apm must be positive when provided";
        return false;
    }
    if (plan.relax_stop.has_energy_tolerance_j != 0 &&
        plan.relax_stop.energy_tolerance_j < 0.0) {
        error = "relax_stop.energy_tolerance_j must be non-negative when provided";
        return false;
    }
    if (plan.relax_stop.has_max_steps != 0 &&
        plan.relax_stop.max_steps == 0) {
        error = "relax_stop.max_steps must be >= 1 when provided";
        return false;
    }
    if (plan.relax_stop.has_max_pseudotime_s != 0 &&
        plan.relax_stop.max_pseudotime_s <= 0.0) {
        error = "relax_stop.max_pseudotime_s must be positive when provided";
        return false;
    }
    if (plan.relax_stop.has_max_physical_time_s != 0 &&
        plan.relax_stop.max_physical_time_s <= 0.0) {
        error = "relax_stop.max_physical_time_s must be positive when provided";
        return false;
    }
    if (plan.oersted_field_xyz != nullptr &&
        plan.oersted_field_len != expected_m_len) {
        error = "oersted_field_xyz length mismatch";
        return false;
    }
    if (plan.has_oersted_cylinder != 0 &&
        plan.oersted_field_xyz != nullptr &&
        plan.oersted_field_len > 0) {
        error = "oersted cylinder and explicit oersted_field_xyz are mutually exclusive";
        return false;
    }
    if (plan.has_zhang_li_stt != 0 && plan.has_slonczewski_stt != 0) {
        error = "native FEM plan supports only one executable STT family at a time";
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
    ctx.field_refresh = plan.field_refresh;
    ctx.relax_stop = plan.relax_stop;
    ctx.stage_completion = {};
    ctx.relax_pseudotime_s = 0.0;
    ctx.relax_previous_total_energy_j = 0.0;
    ctx.relax_previous_total_energy_valid = false;
    ctx.relax_energy_window_j = {};
    ctx.relax_energy_window_count = 0;
    ctx.relax_energy_window_next = 0;
    ctx.demag_cache_valid = false;
    ctx.demag_last_refresh_time = -1.0;
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
    if (plan.mesh.n_periodic_node_pairs > 0) {
        const size_t pair_scalar_count =
            static_cast<size_t>(plan.mesh.n_periodic_node_pairs) * 2u;
        ctx.periodic_node_pairs.assign(
            plan.mesh.periodic_node_pairs,
            plan.mesh.periodic_node_pairs + pair_scalar_count);
        for (uint32_t pair_index = 0; pair_index < plan.mesh.n_periodic_node_pairs; ++pair_index) {
            const uint32_t node_a = ctx.periodic_node_pairs[static_cast<size_t>(pair_index) * 2u];
            const uint32_t node_b = ctx.periodic_node_pairs[static_cast<size_t>(pair_index) * 2u + 1u];
            if (node_a >= ctx.n_nodes || node_b >= ctx.n_nodes) {
                error = "FEM mesh periodic_node_pairs references node outside mesh";
                return false;
            }
            if (node_a == node_b) {
                error = "FEM mesh periodic_node_pairs contains a self-pair";
                return false;
            }
        }
        if (!build_static_periodic_reduction(ctx, error)) {
            return false;
        }
        // Populate periodic_boundary_marker_set for Robin BC exclusion.
        ctx.periodic_boundary_marker_set.clear();
        if (plan.mesh.periodic_boundary_pair_markers != nullptr &&
            plan.mesh.periodic_boundary_pair_count > 0) {
            for (uint32_t i = 0; i < plan.mesh.periodic_boundary_pair_count; ++i) {
                ctx.periodic_boundary_marker_set.insert(
                    plan.mesh.periodic_boundary_pair_markers[2u * i]);
                ctx.periodic_boundary_marker_set.insert(
                    plan.mesh.periodic_boundary_pair_markers[2u * i + 1u]);
            }
        }
    }
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
    ctx.has_zhang_li_stt = plan.has_zhang_li_stt != 0;
    ctx.has_slonczewski_stt = plan.has_slonczewski_stt != 0;
    ctx.stt_current_density_am2 = {
        plan.stt_current_density_am2[0],
        plan.stt_current_density_am2[1],
        plan.stt_current_density_am2[2],
    };
    ctx.stt_degree = plan.stt_degree;
    ctx.stt_beta = plan.stt_beta;
    ctx.stt_spin_polarization = {
        plan.stt_spin_polarization[0],
        plan.stt_spin_polarization[1],
        plan.stt_spin_polarization[2],
    };
    ctx.stt_lambda = plan.stt_lambda;
    ctx.stt_epsilon_prime = plan.stt_epsilon_prime;
    ctx.stt_free_layer_thickness = plan.stt_free_layer_thickness;
    ctx.stt_current_sign = plan.stt_current_sign;

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
        if (!std::isfinite(ctx.material.gyromagnetic_ratio) ||
            ctx.material.gyromagnetic_ratio <= 0.0) {
            error = "material.gyromagnetic_ratio must be finite and > 0; native FEM expects gamma_mu0 in m/(A s), not gamma in rad/(T s)";
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
        if (ctx.has_slonczewski_stt) {
            double len = std::sqrt(
                ctx.stt_spin_polarization[0] * ctx.stt_spin_polarization[0] +
                ctx.stt_spin_polarization[1] * ctx.stt_spin_polarization[1] +
                ctx.stt_spin_polarization[2] * ctx.stt_spin_polarization[2]);
            if (!(len > kZeroThreshold) || !std::isfinite(len)) {
                error = "stt_spin_polarization must be finite and non-zero";
                return false;
            }
            ctx.stt_spin_polarization[0] /= len;
            ctx.stt_spin_polarization[1] /= len;
            ctx.stt_spin_polarization[2] /= len;
        }
    }

    // Adaptive time-stepping from plan
    if (plan.adaptive_config != nullptr) {
        const auto &adaptive = *plan.adaptive_config;
        if (!std::isfinite(adaptive.atol) || adaptive.atol <= 0.0) {
            error = "adaptive_config.atol must be finite and > 0";
            return false;
        }
        if (!std::isfinite(adaptive.rtol) || adaptive.rtol <= 0.0) {
            error = "adaptive_config.rtol must be finite and > 0";
            return false;
        }
        if (!std::isfinite(adaptive.dt_initial) || adaptive.dt_initial < 0.0) {
            error = "adaptive_config.dt_initial must be finite and >= 0";
            return false;
        }
        if (!std::isfinite(adaptive.dt_min) || adaptive.dt_min <= 0.0) {
            error = "adaptive_config.dt_min must be finite and > 0";
            return false;
        }
        if (!std::isfinite(adaptive.dt_max) || adaptive.dt_max < adaptive.dt_min) {
            error = "adaptive_config.dt_max must be finite and >= adaptive_config.dt_min";
            return false;
        }
        if (!std::isfinite(adaptive.safety) ||
            adaptive.safety <= 0.0 ||
            adaptive.safety >= 1.0) {
            error = "adaptive_config.safety must be finite and satisfy 0 < safety < 1";
            return false;
        }
        if (!std::isfinite(adaptive.growth_limit) || adaptive.growth_limit <= 1.0) {
            error = "adaptive_config.growth_limit must be finite and > 1";
            return false;
        }
        if (!std::isfinite(adaptive.shrink_limit) ||
            adaptive.shrink_limit <= 0.0 ||
            adaptive.shrink_limit >= 1.0) {
            error = "adaptive_config.shrink_limit must be finite and satisfy 0 < shrink_limit < 1";
            return false;
        }
        if (adaptive.max_reject == 0) {
            error = "adaptive_config.max_reject must be > 0";
            return false;
        }
        ctx.adaptive_dt_enabled = true;
        ctx.adaptive_atol = adaptive.atol;
        ctx.adaptive_rtol = adaptive.rtol;
        ctx.dt_seconds = adaptive.dt_initial > 0.0
                             ? adaptive.dt_initial
                             : plan.dt_seconds;
        ctx.current_dt = ctx.dt_seconds;
        ctx.dt_min = adaptive.dt_min;
        ctx.dt_max = adaptive.dt_max;
        ctx.safety_factor = adaptive.safety;
        ctx.dt_grow_max = adaptive.growth_limit;
        ctx.dt_shrink_min = adaptive.shrink_limit;
        ctx.max_reject = adaptive.max_reject;
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
    project_static_periodic_aos(ctx, ctx.m_xyz);

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
    fill_zero_vector_field(ctx.h_cubic_ani_xyz, ctx.n_nodes);
    fill_zero_vector_field(ctx.h_bulk_dmi_xyz, ctx.n_nodes);

    // Precompute per-node dual volumes for thermal noise (must come after
    // magnetic_element_mask and elements are populated).
    compute_node_volumes(ctx);

    initialize_uniform_zeeman_field(ctx);
    if (ctx.has_external_field) {
        ctx.h_eff_xyz = ctx.h_ext_xyz;
    } else {
        fill_zero_vector_field(ctx.h_eff_xyz, ctx.n_nodes);
    }

    // ── Oersted field (cylindrical conductor) ──
    ctx.has_oersted_cylinder = plan.has_oersted_cylinder != 0;
    ctx.has_oersted_field = plan.oersted_field_xyz != nullptr && plan.oersted_field_len > 0;
    ctx.oersted_current = plan.oersted_current;
    ctx.oersted_radius = plan.oersted_radius;
    for (int i = 0; i < 3; ++i) {
        ctx.oersted_center[i] = plan.oersted_center[i];
        ctx.oersted_axis[i] = plan.oersted_axis[i];
    }
    if (!normalize_oersted_cylinder_axis(ctx, error)) {
        return false;
    }
    ctx.oersted_time_dep_kind = plan.oersted_time_dep_kind;
    ctx.oersted_time_dep_freq = plan.oersted_time_dep_freq;
    ctx.oersted_time_dep_phase = plan.oersted_time_dep_phase;
    ctx.oersted_time_dep_offset = plan.oersted_time_dep_offset;
    ctx.oersted_time_dep_t_on = plan.oersted_time_dep_t_on;
    ctx.oersted_time_dep_t_off = plan.oersted_time_dep_t_off;

    if (ctx.has_oersted_field) {
        ctx.h_oe_xyz.assign(
            plan.oersted_field_xyz,
            plan.oersted_field_xyz + static_cast<size_t>(plan.oersted_field_len));
    } else if (!initialize_oersted_cylinder_field(ctx, error)) {
        return false;
    }

    // ── Thermal noise (Brown field) ──
    ctx.temperature = plan.temperature;
    initialize_thermal_brown_field(ctx);

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

    // FND-013: read consistent-mass flag from plan.
    // ctx.use_consistent_mass = (plan.use_consistent_mass != 0);

    const bool consistent_mass_requested = plan.use_consistent_mass != 0;
    if (!ctx.periodic_node_pairs.empty()) {
        if (!ctx.enable_exchange) {
            error =
                "native FEM periodic_node_pairs require enable_exchange=true";
            return false;
        }
        // Reject terms that require P^T A P operator reduction or that have
        // no algebraic periodic path.  Local anisotropy and DMI are node-local
        // operations and are supported after per-class material validation.
        // Demag PBC is handled by the algebraic P^T A P reduced Poisson system
        // in context_initialize_poisson (requires FULLMAG_HAS_MFEM_STACK).
#if !FULLMAG_HAS_MFEM_STACK
        const bool demag_pbc_supported = false;
#else
        const bool demag_pbc_supported = true;
#endif
        if ((!demag_pbc_supported && ctx.enable_demag) ||
            ctx.enable_magnetoelastic || ctx.has_oersted_cylinder ||
            ctx.has_oersted_field || ctx.temperature > 0.0 ||
            ctx.has_zhang_li_stt || ctx.has_slonczewski_stt) {
            error =
                "native FEM time-domain periodic_node_pairs currently support only "
                "exchange, uniform Zeeman field, local anisotropy, DMI, and (MFEM stack) "
                "demag via algebraic P^T A P; magnetoelastic, thermal noise, "
                "Oersted and STT require dedicated periodic reduced operators";
            return false;
        }
        // Validate base material fields per periodic class.
        if (!validate_periodic_scalar_field_classes(ctx, ctx.Ms_field, "Ms_field", error) ||
            !validate_periodic_scalar_field_classes(ctx, ctx.A_field, "A_field", error) ||
            !validate_periodic_scalar_field_classes(ctx, ctx.alpha_field, "alpha_field", error)) {
            return false;
        }
        // Validate anisotropy material fields per periodic class (if present).
        if (ctx.enable_anisotropy || ctx.enable_cubic_anisotropy) {
            if (!validate_periodic_scalar_field_classes(ctx, ctx.Ku_field, "Ku_field", error) ||
                !validate_periodic_scalar_field_classes(ctx, ctx.Ku2_field, "Ku2_field", error) ||
                !validate_periodic_scalar_field_classes(ctx, ctx.Kc1_field, "Kc1_field", error) ||
                !validate_periodic_scalar_field_classes(ctx, ctx.Kc2_field, "Kc2_field", error) ||
                !validate_periodic_scalar_field_classes(ctx, ctx.Kc3_field, "Kc3_field", error)) {
                return false;
            }
        }
        // Validate DMI per-node material fields per periodic class (if present).
        if (ctx.enable_dmi || ctx.enable_bulk_dmi) {
            if (!validate_periodic_scalar_field_classes(ctx, ctx.Dind_field, "Dind_field", error) ||
                !validate_periodic_scalar_field_classes(ctx, ctx.Dbulk_field, "Dbulk_field", error)) {
                return false;
            }
        }
    }

#if FULLMAG_HAS_MFEM_STACK
    ctx.use_consistent_mass = consistent_mass_requested;
    if (!context_initialize_mfem(ctx, error)) {
        return false;
    }
    // Initialize the requested demag operator only after the shared MFEM mesh is ready.
    if (ctx.enable_demag &&
        (ctx.demag_realization == FULLMAG_FEM_DEMAG_AIRBOX_DIRICHLET ||
         ctx.demag_realization == FULLMAG_FEM_DEMAG_AIRBOX_ROBIN)) {
        if (!context_initialize_poisson(ctx, error)) {
            return false;
        }
    } else if (ctx.enable_demag &&
               ctx.demag_realization == FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER) {
        if (!context_initialize_demag_fem_bem(ctx, error)) {
            return false;
        }
    } else if (ctx.enable_demag) {
        error = "unsupported native FEM demag realization";
        return false;
    }
    if (plan.eager_initial_effective_field != 0 &&
        (ctx.enable_exchange || ctx.enable_demag) &&
        !context_refresh_exchange_field_mfem(ctx, error)) {
        return false;
    }
    context_populate_device_info(ctx);
#endif
    bool allocate_gpu_state = false;
#if FULLMAG_HAS_CUDA_RUNTIME
    allocate_gpu_state = ctx.device_info_cache.is_gpu_enabled != 0;
#endif
    if (!gpu_state_initialize(
            ctx.gpu_state,
            ctx.n_nodes,
            ctx.integrator,
            allocate_gpu_state,
            ctx.m_xyz.data(),
            static_cast<uint64_t>(ctx.m_xyz.size()),
            ctx.transfer_audit,
            error)) {
#if FULLMAG_HAS_MFEM_STACK
        context_destroy_mfem(ctx);
#endif
        return false;
    }
    if (!gpu_state_upload_runtime_coefficients(
            ctx.gpu_state,
            ctx.node_volumes.data(),
            static_cast<uint64_t>(ctx.node_volumes.size()),
            ctx.Ms_field.data(),
            static_cast<uint64_t>(ctx.Ms_field.size()),
            ctx.material.saturation_magnetisation,
            ctx.A_field.data(),
            static_cast<uint64_t>(ctx.A_field.size()),
            ctx.material.exchange_stiffness,
            ctx.alpha_field.data(),
            static_cast<uint64_t>(ctx.alpha_field.size()),
            ctx.material.damping,
            ctx.Ku_field.data(),
            static_cast<uint64_t>(ctx.Ku_field.size()),
            ctx.Ku2_field.data(),
            static_cast<uint64_t>(ctx.Ku2_field.size()),
            ctx.Dind_field.data(),
            static_cast<uint64_t>(ctx.Dind_field.size()),
            ctx.Dbulk_field.data(),
            static_cast<uint64_t>(ctx.Dbulk_field.size()),
            ctx.Kc1_field.data(),
            static_cast<uint64_t>(ctx.Kc1_field.size()),
            ctx.Kc2_field.data(),
            static_cast<uint64_t>(ctx.Kc2_field.size()),
            ctx.Kc3_field.data(),
            static_cast<uint64_t>(ctx.Kc3_field.size()),
            ctx.magnetic_node_mask.data(),
            static_cast<uint64_t>(ctx.magnetic_node_mask.size()),
            ctx.periodic_reduced_node.data(),
            static_cast<uint64_t>(ctx.periodic_reduced_node.size()),
            ctx.periodic_representative_nodes.data(),
            static_cast<uint64_t>(ctx.periodic_representative_nodes.size()),
            ctx.transfer_audit,
            error)) {
#if FULLMAG_HAS_MFEM_STACK
        context_destroy_mfem(ctx);
#endif
        return false;
    }
    if (ctx.enable_magnetoelastic && !ctx.mel_uniform_strain) {
        if (!gpu_state_upload_magnetoelastic_strain(
                ctx.gpu_state,
                ctx.mel_strain_voigt.data(),
                static_cast<uint64_t>(ctx.mel_strain_voigt.size()),
                ctx.transfer_audit,
                error)) {
#if FULLMAG_HAS_MFEM_STACK
            context_destroy_mfem(ctx);
#endif
            return false;
        }
    }
    if (!gpu_state_upload_mesh_geometry(
            ctx.gpu_state,
            ctx.nodes_xyz.data(),
            static_cast<uint64_t>(ctx.nodes_xyz.size()),
            ctx.elements.data(),
            static_cast<uint64_t>(ctx.elements.size()),
            ctx.magnetic_element_mask.data(),
            static_cast<uint64_t>(ctx.magnetic_element_mask.size()),
            ctx.transfer_audit,
            error)) {
#if FULLMAG_HAS_MFEM_STACK
        context_destroy_mfem(ctx);
#endif
        return false;
    }
#if FULLMAG_HAS_MFEM_STACK
    if (!context_upload_mfem_exchange_to_gpu_state(ctx, error)) {
        context_destroy_mfem(ctx);
        return false;
    }
#endif
    if (!gpu_state_upload_effective_fields_aos(
            ctx.gpu_state,
            ctx.h_ex_xyz.data(),
            ctx.h_demag_xyz.data(),
            ctx.h_ext_xyz.data(),
            ctx.h_eff_xyz.data(),
            static_cast<uint64_t>(ctx.h_eff_xyz.size()),
            ctx.transfer_audit,
            error)) {
#if FULLMAG_HAS_MFEM_STACK
        context_destroy_mfem(ctx);
#endif
        return false;
    }
    if (!gpu_state_upload_local_vector_fields_aos(
            ctx.gpu_state,
            ctx.h_ani_xyz.data(),
            ctx.h_cubic_ani_xyz.data(),
            ctx.h_dmi_xyz.data(),
            ctx.h_bulk_dmi_xyz.data(),
            ctx.h_oe_xyz.data(),
            ctx.h_therm_xyz.data(),
            ctx.h_mel_xyz.data(),
            static_cast<uint64_t>(ctx.h_eff_xyz.size()),
            ctx.transfer_audit,
            error)) {
#if FULLMAG_HAS_MFEM_STACK
        context_destroy_mfem(ctx);
#endif
        return false;
    }
    return true;
}

bool context_sync_gpu_magnetization_to_host(Context &ctx, std::string &error)
{
    if (!ctx.gpu_state.allocated ||
        ctx.gpu_state.source_of_truth != FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH ||
        ctx.gpu_state.host_state != FemGpuSyncState::HostStale) {
        return true;
    }
    if (!gpu_state_download_magnetization_aos(
            ctx.gpu_state,
            ctx.m_xyz,
            ctx.transfer_audit,
            error)) {
        error = "GPU magnetization readback failed: " + error;
        return false;
    }
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

    const uint64_t bytes = sizeof(double) * out_len;
    record_device_to_host(ctx.transfer_audit, bytes);
    std::memcpy(out_xyz, source->data(), static_cast<size_t>(bytes));
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
    if (ctx.gpu_state.allocated) {
        if (!gpu_state_upload_magnetization_aos(
                ctx.gpu_state,
                ctx.m_xyz.data(),
                static_cast<uint64_t>(ctx.m_xyz.size()),
                ctx.transfer_audit,
                error)) {
            return FULLMAG_FEM_ERR_INTERNAL;
        }
    } else {
        record_host_to_device(ctx.transfer_audit, sizeof(double) * len);
    }
    ctx.stepper.fsal_valid = false;
    ctx.prev_error_norm = 1.0;
    ctx.demag_cache_valid = false;
    ctx.demag_last_refresh_time = -1.0;

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

    if (!gpu_state_upload_effective_fields_aos(
            ctx.gpu_state,
            ctx.h_ex_xyz.data(),
            ctx.h_demag_xyz.data(),
            ctx.h_ext_xyz.data(),
            ctx.h_eff_xyz.data(),
            static_cast<uint64_t>(ctx.h_eff_xyz.size()),
            ctx.transfer_audit,
            error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (!gpu_state_upload_local_vector_fields_aos(
            ctx.gpu_state,
            ctx.h_ani_xyz.data(),
            ctx.h_cubic_ani_xyz.data(),
            ctx.h_dmi_xyz.data(),
            ctx.h_bulk_dmi_xyz.data(),
            ctx.h_oe_xyz.data(),
            ctx.h_therm_xyz.data(),
            ctx.h_mel_xyz.data(),
            static_cast<uint64_t>(ctx.h_eff_xyz.size()),
            ctx.transfer_audit,
            error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    return FULLMAG_FEM_OK;
}

void context_populate_device_info(Context &ctx) {
    std::memset(&ctx.device_info_cache, 0, sizeof(ctx.device_info_cache));
#if FULLMAG_HAS_MFEM_STACK
    // FND-007: backend name reflects the actual demag realization in use.
    // Phase-0D fix: use device-aware prefix instead of hard-coding "cuda".
    const char *mfem_dev = configured_mfem_device_string(ctx);
    const bool on_gpu = is_gpu_device_string(mfem_dev);
    const char *dev_tag = on_gpu ? "gpu" : "cpu";

    std::string backend_name;
    if (ctx.mfem_exchange_ready) {
        if (!ctx.enable_demag) {
            backend_name = std::string("mfem_") + dev_tag + "_exchange_ready";
        } else if (ctx.demag_realization == FULLMAG_FEM_DEMAG_AIRBOX_DIRICHLET) {
            backend_name = std::string("mfem_") + dev_tag + "_native_poisson_dirichlet_demag";
        } else if (ctx.demag_realization == FULLMAG_FEM_DEMAG_AIRBOX_ROBIN) {
            backend_name = std::string("mfem_") + dev_tag + "_native_poisson_robin_demag";
        } else if (ctx.demag_realization == FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER) {
            backend_name = std::string("mfem_") + dev_tag + "_native_fem_bem_demag";
        } else {
            backend_name = std::string("mfem_") + dev_tag + "_unknown_demag_realization";
        }
    } else if (ctx.mfem_ready) {
        backend_name = std::string("mfem_") + dev_tag + "_mesh_ready";
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
    ctx.device_info_cache.is_gpu_enabled = on_gpu ? 1 : 0;
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

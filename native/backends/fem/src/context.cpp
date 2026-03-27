#include "context.hpp"

#include <algorithm>
#include <cstring>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

namespace {

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
    ctx.material = plan.material;
    ctx.demag_solver = plan.demag_solver;
#if FULLMAG_HAS_MFEM_STACK
    ctx.demag_realization = static_cast<int>(plan.demag_realization);
    ctx.poisson_boundary_marker = plan.poisson_boundary_marker;
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
    // Build magnetic element mask (matches CPU: marker 1 = magnetic when
    // both marker-1 and non-marker-1 elements exist; otherwise all magnetic).
    {
        ctx.magnetic_element_mask.assign(static_cast<size_t>(ctx.n_elements), 1u);
        if (!ctx.element_markers.empty()) {
            bool has_marker_1 = false;
            bool has_other = false;
            for (size_t i = 0; i < ctx.element_markers.size(); ++i) {
                if (ctx.element_markers[i] == 1u) {
                    has_marker_1 = true;
                } else {
                    has_other = true;
                }
            }
            if (has_marker_1 && has_other) {
                for (size_t i = 0; i < ctx.element_markers.size(); ++i) {
                    ctx.magnetic_element_mask[i] =
                        ctx.element_markers[i] == 1u ? 1u : 0u;
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
    if (ctx.has_external_field) {
        fill_repeated_vector_field(ctx.h_ext_xyz, ctx.n_nodes, ctx.external_field_am);
        ctx.h_eff_xyz = ctx.h_ext_xyz;
    } else {
        fill_zero_vector_field(ctx.h_ext_xyz, ctx.n_nodes);
        fill_zero_vector_field(ctx.h_eff_xyz, ctx.n_nodes);
    }

    context_populate_device_info(ctx);
#if FULLMAG_HAS_MFEM_STACK
    if (!context_initialize_mfem(ctx, error)) {
        return false;
    }
    // Initialize Poisson demag solver if requested
    if (ctx.enable_demag && ctx.demag_realization == 1 /* POISSON_AIRBOX */) {
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
            source = &ctx.h_demag_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_EXT:
            source = &ctx.h_ext_xyz;
            break;
        case FULLMAG_FEM_OBSERVABLE_H_EFF:
            source = &ctx.h_eff_xyz;
            break;
        default:
            error = "unsupported FEM observable";
            return FULLMAG_FEM_ERR_INVALID;
    }

    std::memcpy(out_xyz, source->data(), sizeof(double) * static_cast<size_t>(out_len));
    return FULLMAG_FEM_OK;
}

void context_populate_device_info(Context &ctx) {
    std::memset(&ctx.device_info_cache, 0, sizeof(ctx.device_info_cache));
#if FULLMAG_HAS_MFEM_STACK
    std::string backend_name = ctx.mfem_exchange_ready
        ? (ctx.enable_demag ? "mfem_cuda_transfer_grid_demag_ready" : "mfem_cuda_exchange_ready")
        : (ctx.mfem_ready ? "mfem_cuda_mesh_ready" : "mfem_stack_uninitialized");
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

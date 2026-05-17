#include "cpu/mfem/runtime/gpu_state_runtime.hpp"

#include "context.hpp"
#include "cpu/mfem/runtime/mfem_context.hpp"
#include "gpu_state.hpp"

#include <cstdint>

namespace fullmag::fem {

namespace {

bool gpu_bootstrap_failed(Context &ctx) {
#if FULLMAG_HAS_MFEM_STACK
    context_destroy_mfem(ctx);
#else
    (void)ctx;
#endif
    return false;
}

} // namespace

bool initialize_context_gpu_state(Context &ctx, std::string &error) {
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
        return gpu_bootstrap_failed(ctx);
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
        return gpu_bootstrap_failed(ctx);
    }
    if (ctx.enable_magnetoelastic && !ctx.mel_uniform_strain) {
        if (!gpu_state_upload_magnetoelastic_strain(
                ctx.gpu_state,
                ctx.mel_strain_voigt.data(),
                static_cast<uint64_t>(ctx.mel_strain_voigt.size()),
                ctx.transfer_audit,
                error)) {
            return gpu_bootstrap_failed(ctx);
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
        return gpu_bootstrap_failed(ctx);
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
        return gpu_bootstrap_failed(ctx);
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
        return gpu_bootstrap_failed(ctx);
    }
    return true;
}

} // namespace fullmag::fem

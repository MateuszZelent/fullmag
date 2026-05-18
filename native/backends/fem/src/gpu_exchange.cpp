/*
 * GPU exchange facade source contract.
 *
 * This source owns GPU exchange path readiness planning: checking CUDA/MFEM
 * support, legacy sparse exchange metadata, mass upload, runtime coefficients,
 * and device CSR dimensions before enabling device-resident exchange stages. It does not own Context construction, MFEM exchange assembly, CPU fallback exchange, integrator execution, or C ABI entrypoints.
 */

#include "gpu_exchange.hpp"

#include "context.hpp"

namespace fullmag::fem {

GpuExchangePlan gpu_exchange_plan_stage_exchange(const Context &ctx, std::string &reason)
{
    (void)ctx;
    GpuExchangePlan plan{};

#if !FULLMAG_HAS_CUDA_RUNTIME
    reason = "stage H_ex device-resident exchange requires CUDA runtime support";
    return plan;
#elif !FULLMAG_HAS_MFEM_STACK
    reason = "stage H_ex device-resident exchange requires MFEM stack support";
    return plan;
#else
    if (ctx.exchange.mfem.use_consistent_mass) {
        reason =
            "stage H_ex device-resident exchange supports only lumped-mass "
            "legacy sparse exchange; consistent-mass projection is still host/MFEM";
        return plan;
    }
    if (!ctx.mesh.periodic_reduced_node.empty()) {
        reason =
            "stage H_ex device-resident exchange does not support periodic "
            "reduced-node exchange yet";
        return plan;
    }
    if (!ctx.gpu_exchange.legacy_sparse_metadata_ready) {
        reason = "stage H_ex device-resident exchange requires captured legacy sparse exchange metadata";
        return plan;
    }
    if (!ctx.gpu_exchange.lumped_mass_ready) {
        reason = "stage H_ex device-resident exchange requires captured lumped mass metadata";
        return plan;
    }
    if (!ctx.gpu_state.runtime_coefficients_uploaded) {
        reason =
            "stage H_ex device-resident exchange requires device-resident "
            "runtime coefficients";
        return plan;
    }
    if (!ctx.gpu_state.exchange_legacy_sparse_uploaded) {
        reason = "stage H_ex device-resident exchange requires device-resident CSR/mass upload";
        return plan;
    }
    if (ctx.gpu_state.exchange_legacy_sparse_rows != ctx.gpu_state.node_count ||
        ctx.gpu_state.exchange_legacy_sparse_cols != ctx.gpu_state.node_count) {
        reason =
            "stage H_ex device-resident exchange requires legacy sparse CSR "
            "dimensions to match FemGpuState node_count";
        return plan;
    }
    plan.stage_exchange_device_resident = true;
    plan.supports_legacy_sparse_gpu = true;
    plan.operator_mode = "legacy_sparse_gpu";
    reason.clear();
    return plan;
#endif
}

} // namespace fullmag::fem

/* Host policy contract for the device-resident PGBB accepted-field cache. */
#include "context.hpp"
#include "gpu/cuda/relaxation/pgbb.hpp"
#include "gpu/cuda/relaxation/relaxation_state.hpp"
#include "gpu/cuda/state/gpu_state.hpp"
#include "cuda_pgbb_final_energy_overlay_fixture.hpp"

#include <cstdio>
#include <cstdlib>
#include <string>

namespace {
void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void exact_one_use_identity()
{
    using namespace fullmag::fem;
    FemGpuPgbbFieldKey key{};
    for (size_t i = 0; i < key.values.size(); ++i) {
        key.values[i] = i + 1;
    }
    FemGpuPgbbFieldToken token{true, key};
    check(gpu_relax_consume_pgbb_field(token, key, true), "same endpoint reuses field");
    check(!gpu_relax_consume_pgbb_field(token, key, true), "token cannot be replayed");
    for (size_t i = 0; i < key.values.size(); ++i) {
        auto different = key;
        different.values[i] ^= 1;
        token = {true, key};
        check(!gpu_relax_consume_pgbb_field(token, different, true),
              "every provenance component must match exactly");
        check(!token.valid, "mismatch consumes the stale token");
    }
    token = {true, key};
    check(!gpu_relax_consume_pgbb_field(token, key, false), "unsupported source stays fresh");
}

void upload_and_generation_invalidation()
{
    using namespace fullmag::fem;
    FemGpuState state{};
    state.relaxation.pgbb_accepted_field.valid = true;
    state.relaxation.accepted_evaluation.valid = true;
    const auto generation = state.relaxation.state_generation;
    gpu_relax_note_external_state_change(state.relaxation);
    check(state.relaxation.state_generation == generation + 1, "external mutation advances generation");
    check(!state.relaxation.pgbb_accepted_field.valid &&
          !state.relaxation.accepted_evaluation.valid, "mutation invalidates both minimizers");

    // Invalid arguments must fence reuse even if an upload fails after a
    // partial copy. No device allocation or CUDA runtime is needed here.
    state.relaxation.pgbb_accepted_field.valid = true;
    state.lifecycle.allocated = true;
    state.lifecycle.dof_len = 3;
    TransferAudit audit{};
    std::string reason;
    check(!gpu_state_upload_magnetization_aos(state, nullptr, 3, audit, reason),
          "invalid upload is rejected");
    check(!state.relaxation.pgbb_accepted_field.valid, "failed upload fences accepted field");
}

#if FULLMAG_HAS_MFEM_STACK
void physical_policy_and_source_identity()
{
    using namespace fullmag::fem;
    Context ctx{};
    ctx.demag.enabled = true;
    ctx.poisson_demag.gpu_demag_mode = FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON;
    ctx.demag.solver.relative_tolerance = 1e-12;
    FemGpuPgbbFieldKey baseline{}, actual{};
    check(gpu_relax_pgbb_field_reuse_key(ctx, baseline), "static Poisson operator is eligible");
    ctx.stage_completion.relax_torque_confirmation_count = 1;
    check(!gpu_relax_pgbb_field_reuse_key(ctx, actual),
          "torque convergence confirmation must obtain a fresh field evaluation");
    ctx.stage_completion.relax_torque_confirmation_count = 0;
    check(gpu_relax_pgbb_field_reuse_key(ctx, actual) && baseline == actual,
          "unchanged accepted operator has equivalent exact key");
    const auto original_stop = ctx.stage_completion.relax_stop;
    ctx.stage_completion.relax_stop.has_torque_tolerance_apm = 1;
    ctx.stage_completion.relax_stop.torque_tolerance_apm = 1.0;
    check(gpu_relax_pgbb_field_reuse_key(ctx, actual) && !(baseline == actual),
          "changing convergence policy cannot reuse an old endpoint confirmation");
    ctx.stage_completion.relax_stop = original_stop;

    ctx.demag.solver.relative_tolerance *= 0.1;
    check(gpu_relax_pgbb_field_reuse_key(ctx, actual) && !(baseline == actual),
          "refined tolerance cannot masquerade as ordinary tolerance");
    ctx.demag.solver.relative_tolerance = 1e-12;
    ctx.zeeman.external_field_am[0] = 1.0;
    check(gpu_relax_pgbb_field_reuse_key(ctx, actual) && !(baseline == actual),
          "constant field values participate in identity");
    ctx.zeeman.external_field_am[0] = 0.0;
    ctx.demag.amg_policy.relax_type += 1;
    check(gpu_relax_pgbb_field_reuse_key(ctx, actual) && !(baseline == actual),
          "AMG policy participates in identity");
    ctx.demag.amg_policy.relax_type -= 1;
    ctx.state.current_time = 1.0;
    check(!gpu_relax_pgbb_field_reuse_key(ctx, actual), "nonzero source time stays fresh");
    ctx.state.current_time = 0.0;
    ctx.zeeman.regional_drives.emplace_back();
    check(!gpu_relax_pgbb_field_reuse_key(ctx, actual), "regional sources stay fresh");
    ctx.zeeman.regional_drives.clear();
    ctx.gpu_state.device.mesh_regions.has_periodic_reduced_nodes = true;
    check(!gpu_relax_pgbb_field_reuse_key(ctx, actual), "periodic projection stays fresh");
    ctx.gpu_state.device.mesh_regions.has_periodic_reduced_nodes = false;
    ctx.anisotropy.uniaxial_enabled = true;
    check(!gpu_relax_pgbb_field_reuse_key(ctx, actual), "unqualified local operator stays fresh");
}
#endif
} // namespace

int main()
{
    exact_one_use_identity();
    upload_and_generation_invalidation();
    fullmag::fem::test::gpu_pgbb_final_energy_overlay_contract(check);
#if FULLMAG_HAS_MFEM_STACK
    physical_policy_and_source_identity();
#endif
    std::puts("PASS: CUDA PGBB accepted-field reuse policy");
    return 0;
}

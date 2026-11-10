#include "context.hpp"
#include "cpu/mfem/relaxation/relaxation_math.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif
#include <cstdio>
#include <cstdlib>

namespace {
void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

#if FULLMAG_HAS_MFEM_STACK
void accepted_cache_guards_exact_inputs()
{
    using namespace fullmag::fem;
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        1, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    Context ctx{};
    ctx.mfem_context.mesh = &mesh;
    ctx.demag.enabled = true;
    ctx.exchange.enabled = true;
    ctx.exchange.mfem.ready = true;
    ctx.exchange.mfem.operator_lifecycle.setup_complete = true;
    ctx.demag.realization = FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
    ctx.demag.solver.relative_tolerance = 1e-12;
    ctx.poisson_demag.ready = true;
    ctx.poisson_demag.operator_lifecycle.setup_complete = true;
    ctx.state.m_xyz = {1.0, 0.0, 0.0};
    ctx.exchange.h_xyz = {0.0, 2.0, 0.0};
    ctx.demag.h_xyz = {-1.0, 0.0, 0.0};
    ctx.effective_field.h_xyz = {-1.0, 2.0, 0.0};
    ctx.material_fields.Ms_field = {8e5};
    ctx.material_fields.A_field = {1.3e-11};
    ctx.material_fields.alpha_field = {1.0};
    ctx.integration_weights.mfem_lumped_mass = {1.0};
    ctx.mesh.node_volumes = {1.0};
    ctx.mesh.magnetic_node_mask = {1u};
    ctx.relaxation.cached_current_stats_valid = true;
    ctx.relaxation.cached_current_stats.max_torque_Apm = 2.0;
    ctx.relaxation.cached_current_stats.total_energy_joules = -3.0;
    auto publish = [&] {
        ctx.poisson_demag.operator_lifecycle.active_key =
            make_poisson_operator_dependency_key(ctx, mesh, false);
        ctx.exchange.mfem.operator_lifecycle.active_key =
            make_exchange_operator_dependency_key(ctx, mesh, false);
        relaxation::publish_pgbb_accepted_stats(ctx, false);
        check(ctx.relaxation.pgbb_accepted_guard.valid, "static accepted endpoint is publishable");
    };
    fullmag_fem_step_stats stats{};
    publish();
    check(relaxation::take_pgbb_accepted_stats(ctx, stats), "unchanged endpoint reuses accepted evaluation");
    check(stats.total_energy_joules == -3.0 && stats.max_torque_Apm == 2.0,
          "reuse preserves accepted numerical observables");
    check(!relaxation::take_pgbb_accepted_stats(ctx, stats), "accepted token is single use");

    const std::array<std::vector<double> *, 9> fields = {
        &ctx.state.m_xyz, &ctx.exchange.h_xyz, &ctx.demag.h_xyz,
        &ctx.effective_field.h_xyz, &ctx.material_fields.Ms_field,
        &ctx.material_fields.A_field, &ctx.material_fields.alpha_field,
        &ctx.integration_weights.mfem_lumped_mass, &ctx.mesh.node_volumes};
    for (auto *field : fields) {
        publish();
        const double saved = (*field)[0];
        (*field)[0] = saved + 1.0;
        check(!relaxation::take_pgbb_accepted_stats(ctx, stats), "changed numerical input fences reuse");
        (*field)[0] = saved;
    }
    publish();
    ctx.state.m_xyz[1] = -0.0;
    check(!relaxation::take_pgbb_accepted_stats(ctx, stats), "endpoint comparison preserves signed zero identity");
    ctx.state.m_xyz[1] = 0.0;
    publish();
    ctx.mesh.magnetic_node_mask[0] = 0;
    check(!relaxation::take_pgbb_accepted_stats(ctx, stats), "mask change fences reuse");
    ctx.mesh.magnetic_node_mask[0] = 1;
    publish();
    ctx.material_fields.material.damping += 0.1;
    check(!relaxation::take_pgbb_accepted_stats(ctx, stats), "uniform damping fences cached RHS metrics");
    ctx.material_fields.material.damping -= 0.1;
    publish();
    ctx.exchange.mfem.use_consistent_mass = !ctx.exchange.mfem.use_consistent_mass;
    check(!relaxation::take_pgbb_accepted_stats(ctx, stats), "mass projection policy change fences reuse");
    ctx.exchange.mfem.use_consistent_mass = !ctx.exchange.mfem.use_consistent_mass;
    publish();
    ctx.base_plan.fe_order += 1;
    // Refresh only the Poisson receipt: exchange's independently owned
    // dependency receipt must still prevent reuse of the old H_ex.
    ctx.poisson_demag.operator_lifecycle.active_key =
        make_poisson_operator_dependency_key(ctx, mesh, false);
    check(!relaxation::take_pgbb_accepted_stats(ctx, stats), "current exchange dependency mismatch fences reuse");
    ctx.base_plan.fe_order -= 1;
    publish();
    ctx.exchange.mfem.ready = false;
    check(!relaxation::take_pgbb_accepted_stats(ctx, stats), "unready exchange operator fences reuse");
    ctx.exchange.mfem.ready = true;
    publish();
    ctx.demag.solver.relative_tolerance *= 0.1;
    check(!relaxation::take_pgbb_accepted_stats(ctx, stats), "refined tolerance fences reuse");
    ctx.demag.solver.relative_tolerance = 1e-12;
    publish();
    mesh.GetVertex(0)[0] += 0.25;
    check(!relaxation::take_pgbb_accepted_stats(ctx, stats), "live mesh dependency change fences reuse");
    mesh.GetVertex(0)[0] -= 0.25;
    publish();
    relaxation::publish_pgbb_accepted_stats(ctx, true);
    check(!ctx.relaxation.pgbb_accepted_guard.valid, "refined evaluation is never published as ordinary");
    ctx.stage_completion.relax_stop.has_torque_tolerance_apm = 1;
    ctx.stage_completion.relax_stop.torque_tolerance_apm = 3.0;
    relaxation::publish_pgbb_accepted_stats(ctx, false);
    check(!ctx.relaxation.pgbb_accepted_guard.valid, "threshold samples require a fresh solve");
    ctx.stage_completion.relax_stop.torque_tolerance_apm = 1.0;
    ctx.stage_completion.relax_torque_confirmation_count = 1;
    relaxation::publish_pgbb_accepted_stats(ctx, false);
    check(!ctx.relaxation.pgbb_accepted_guard.valid, "confirmation sequence requires fresh solves");
}
#endif
} // namespace

int main()
{
#if FULLMAG_HAS_MFEM_STACK
    accepted_cache_guards_exact_inputs();
#endif
    std::puts("PASS: CPU PGBB accepted cache contract");
}

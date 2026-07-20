#include "cpu/mfem/integrators/rk_step_transaction.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_step_transaction_device.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#include <utility>
#include <vector>
#include <new>

namespace fullmag::fem {
namespace {

thread_local Context *active_step_transaction_context = nullptr;

#if FULLMAG_HAS_MFEM_STACK
std::vector<double> capture_vector(const mfem::Vector *vector)
{
    if (vector == nullptr) {
        return {};
    }
    return std::vector<double>(vector->GetData(), vector->GetData() + vector->Size());
}

void restore_vector(mfem::Vector *vector, const std::vector<double> &snapshot)
{
    if (vector == nullptr || snapshot.empty()) {
        return;
    }
    if (vector->Size() != static_cast<int>(snapshot.size())) {
        vector->SetSize(static_cast<int>(snapshot.size()));
    }
    std::copy(snapshot.begin(), snapshot.end(), vector->GetData());
}
#endif

struct PhaseTimingSnapshot {
    bool configured = false;
    bool enabled = false;
    uint64_t exchange_wall_time_ns = 0;
    uint64_t demag_assemble_wall_time_ns = 0;
    uint64_t demag_recover_wall_time_ns = 0;
    uint64_t demag_energy_wall_time_ns = 0;
    uint64_t rhs_wall_time_ns = 0;
    size_t exchange_used = 0;
    size_t demag_assemble_used = 0;
    size_t demag_recover_used = 0;
    size_t demag_energy_used = 0;
    size_t rhs_used = 0;
    uint64_t exchange_overflow_count = 0;
    uint64_t demag_assemble_overflow_count = 0;
    uint64_t demag_recover_overflow_count = 0;
    uint64_t demag_energy_overflow_count = 0;
    uint64_t rhs_overflow_count = 0;
};

#if FULLMAG_HAS_MFEM_STACK
struct PoissonStepStateSnapshot {
    int last_iterations = 0;
    double last_residual = 0.0;
    uint64_t last_setup_wall_time_ns = 0;
    uint64_t last_solver_apply_wall_time_ns = 0;
    uint64_t step_assemble_wall_time_ns = 0;
    uint64_t step_solver_apply_wall_time_ns = 0;
    uint64_t step_recover_wall_time_ns = 0;
    uint64_t step_energy_wall_time_ns = 0;
    bool last_solver_setup_reused = false;
    uint32_t solves_current_step = 0;
    uint32_t setup_count_current_step = 0;
    uint32_t fresh_zero_guess_count_current_step = 0;
    uint32_t event_wait_count_current_step = 0;
    uint32_t global_sync_count_current_step = 0;
    bool fresh_initial_guess_required = false;
};

PoissonStepStateSnapshot capture_poisson_step_state(
    const PoissonDemagRuntimeState &source)
{
    return {
        source.last_iterations,
        source.last_residual,
        source.last_setup_wall_time_ns,
        source.last_solver_apply_wall_time_ns,
        source.step_assemble_wall_time_ns,
        source.step_solver_apply_wall_time_ns,
        source.step_recover_wall_time_ns,
        source.step_energy_wall_time_ns,
        source.last_solver_setup_reused,
        source.solves_current_step,
        source.setup_count_current_step,
        source.fresh_zero_guess_count_current_step,
        source.event_wait_count_current_step,
        source.global_sync_count_current_step,
        source.fresh_initial_guess_required,
    };
}

void restore_poisson_step_state(
    PoissonDemagRuntimeState &target,
    const PoissonStepStateSnapshot &source)
{
    target.last_iterations = source.last_iterations;
    target.last_residual = source.last_residual;
    target.last_setup_wall_time_ns = source.last_setup_wall_time_ns;
    target.last_solver_apply_wall_time_ns = source.last_solver_apply_wall_time_ns;
    target.step_assemble_wall_time_ns = source.step_assemble_wall_time_ns;
    target.step_solver_apply_wall_time_ns = source.step_solver_apply_wall_time_ns;
    target.step_recover_wall_time_ns = source.step_recover_wall_time_ns;
    target.step_energy_wall_time_ns = source.step_energy_wall_time_ns;
    target.last_solver_setup_reused = source.last_solver_setup_reused;
    target.solves_current_step = source.solves_current_step;
    target.setup_count_current_step = source.setup_count_current_step;
    target.fresh_zero_guess_count_current_step =
        source.fresh_zero_guess_count_current_step;
    target.event_wait_count_current_step = source.event_wait_count_current_step;
    target.global_sync_count_current_step = source.global_sync_count_current_step;
    target.fresh_initial_guess_required = source.fresh_initial_guess_required;
}
#endif

PhaseTimingSnapshot capture_phase_timings(const GpuRkPhaseTimingRuntimeState &source)
{
    return {
        source.configured,
        source.enabled,
        source.exchange_wall_time_ns,
        source.demag_assemble_wall_time_ns,
        source.demag_recover_wall_time_ns,
        source.demag_energy_wall_time_ns,
        source.rhs_wall_time_ns,
        source.exchange_used,
        source.demag_assemble_used,
        source.demag_recover_used,
        source.demag_energy_used,
        source.rhs_used,
        source.exchange_overflow_count,
        source.demag_assemble_overflow_count,
        source.demag_recover_overflow_count,
        source.demag_energy_overflow_count,
        source.rhs_overflow_count,
    };
}

void restore_phase_timings(
    GpuRkPhaseTimingRuntimeState &target,
    const PhaseTimingSnapshot &source)
{
    target.configured = source.configured;
    target.enabled = source.enabled;
    target.exchange_wall_time_ns = source.exchange_wall_time_ns;
    target.demag_assemble_wall_time_ns = source.demag_assemble_wall_time_ns;
    target.demag_recover_wall_time_ns = source.demag_recover_wall_time_ns;
    target.demag_energy_wall_time_ns = source.demag_energy_wall_time_ns;
    target.rhs_wall_time_ns = source.rhs_wall_time_ns;
    target.exchange_used = source.exchange_used;
    target.demag_assemble_used = source.demag_assemble_used;
    target.demag_recover_used = source.demag_recover_used;
    target.demag_energy_used = source.demag_energy_used;
    target.rhs_used = source.rhs_used;
    target.exchange_overflow_count = source.exchange_overflow_count;
    target.demag_assemble_overflow_count = source.demag_assemble_overflow_count;
    target.demag_recover_overflow_count = source.demag_recover_overflow_count;
    target.demag_energy_overflow_count = source.demag_energy_overflow_count;
    target.rhs_overflow_count = source.rhs_overflow_count;
}

} // namespace

struct RkStepTransaction::Impl {
    explicit Impl(Context &context)
        : ctx(context),
          base_plan(context.base_plan),
          adaptive_dt(context.adaptive_dt),
          anisotropy(context.anisotropy),
          magnetoelastic(context.magnetoelastic),
          stage_completion(context.stage_completion),
          state(context.state),
          exchange(context.exchange),
          demag(context.demag),
          zeeman(context.zeeman),
          dmi(context.dmi),
          effective_field(context.effective_field),
          oersted(context.oersted),
          thermal_brown(context.thermal_brown),
          transfer_audit(context.transfer_audit.audit),
          gpu_residency(context.gpu_state.device.residency),
          gpu_fsal_valid(context.gpu_state.device.rk.fsal_valid),
          gpu_hybrid_stage_m(context.gpu_state.device.demag_poisson.hybrid_stage_m_xyz),
          gpu_hybrid_demag(context.gpu_state.device.demag_poisson.hybrid_demag_xyz),
          gpu_hybrid_demag_energy(context.gpu_state.device.demag_poisson.hybrid_demag_energy_joules),
          phase_timings(capture_phase_timings(context.gpu_state.rk_phase_timings)),
          cpu_fsal_valid(context.stepper.workspace.fsal_valid),
          cpu_k0(context.stepper.workspace.k[0]),
          attempt_trace(context.stepper.attempt_trace)
    {
#if FULLMAG_HAS_MFEM_STACK
        poisson_step_state = capture_poisson_step_state(context.poisson_demag);
        poisson_solution = capture_vector(context.poisson_demag.solution_vec);
        periodic_solution = capture_vector(context.poisson_demag.periodic_solution);
        poisson_grid_function = capture_vector(context.poisson_demag.gf_potential);
        if (auto *workspace = demag_fem_bem_workspace(context)) {
            fem_bem_u1 = capture_vector(workspace->u1.get());
            fem_bem_u2 = capture_vector(workspace->u2.get());
            fem_bem_total = capture_vector(workspace->total_potential.get());
            fem_bem_boundary = capture_vector(workspace->boundary_values_global.get());
            fem_bem_rhs = capture_vector(workspace->laplace_rhs.get());
            fem_bem_last_u1_iterations = workspace->last_u1_iterations;
            fem_bem_last_u2_iterations = workspace->last_u2_iterations;
            fem_bem_last_u1_residual = workspace->last_u1_residual;
            fem_bem_last_u2_residual = workspace->last_u2_residual;
        }
#endif
    }

    void restore_host()
    {
        ctx.base_plan = base_plan;
        ctx.adaptive_dt = adaptive_dt;
        ctx.anisotropy = anisotropy;
        ctx.magnetoelastic = magnetoelastic;
        ctx.stage_completion = stage_completion;
        ctx.state = state;
        ctx.exchange = exchange;
        ctx.demag = demag;
        ctx.zeeman = zeeman;
        ctx.dmi.h_interfacial_xyz = dmi.h_interfacial_xyz;
        ctx.dmi.h_bulk_xyz = dmi.h_bulk_xyz;
        ctx.dmi.energy_joules = dmi.energy_joules;
        ctx.effective_field = effective_field;
        ctx.oersted = oersted;
        ctx.thermal_brown = thermal_brown;
        ctx.transfer_audit.audit = transfer_audit;
        ctx.gpu_state.device.residency = gpu_residency;
        ctx.gpu_state.device.rk.fsal_valid = gpu_fsal_valid;
        ctx.gpu_state.device.demag_poisson.hybrid_stage_m_xyz = gpu_hybrid_stage_m;
        ctx.gpu_state.device.demag_poisson.hybrid_demag_xyz = gpu_hybrid_demag;
        ctx.gpu_state.device.demag_poisson.hybrid_demag_energy_joules =
            gpu_hybrid_demag_energy;
        restore_phase_timings(ctx.gpu_state.rk_phase_timings, phase_timings);
        ctx.stepper.workspace.fsal_valid = cpu_fsal_valid;
        ctx.stepper.workspace.k[0] = cpu_k0;
        ctx.stepper.attempt_trace = attempt_trace;
#if FULLMAG_HAS_MFEM_STACK
        restore_poisson_step_state(ctx.poisson_demag, poisson_step_state);
        restore_vector(ctx.poisson_demag.solution_vec, poisson_solution);
        restore_vector(ctx.poisson_demag.periodic_solution, periodic_solution);
        restore_vector(ctx.poisson_demag.gf_potential, poisson_grid_function);
        if (auto *workspace = demag_fem_bem_workspace(ctx)) {
            restore_vector(workspace->u1.get(), fem_bem_u1);
            restore_vector(workspace->u2.get(), fem_bem_u2);
            restore_vector(workspace->total_potential.get(), fem_bem_total);
            restore_vector(workspace->boundary_values_global.get(), fem_bem_boundary);
            restore_vector(workspace->laplace_rhs.get(), fem_bem_rhs);
            workspace->last_u1_iterations = fem_bem_last_u1_iterations;
            workspace->last_u2_iterations = fem_bem_last_u2_iterations;
            workspace->last_u1_residual = fem_bem_last_u1_residual;
            workspace->last_u2_residual = fem_bem_last_u2_residual;
        }
#endif
    }

    Context &ctx;
    FemBasePlanRuntimeState base_plan;
    AdaptiveDtRuntimeState adaptive_dt;
    AnisotropyRuntimeState anisotropy;
    MagnetoelasticRuntimeState magnetoelastic;
    StageCompletionRuntimeState stage_completion;
    FemStateRuntimeState state;
    ExchangeRuntimeState exchange;
    DemagRuntimeState demag;
    ZeemanRuntimeState zeeman;
    DmiRuntimeState dmi;
    EffectiveFieldRuntimeState effective_field;
    OerstedRuntimeState oersted;
    ThermalBrownRuntimeState thermal_brown;
    TransferAudit transfer_audit;
    FemGpuResidencyDeviceState gpu_residency;
    bool gpu_fsal_valid;
    std::vector<double> gpu_hybrid_stage_m;
    std::vector<double> gpu_hybrid_demag;
    double gpu_hybrid_demag_energy;
    PhaseTimingSnapshot phase_timings;
    bool cpu_fsal_valid;
    std::vector<double> cpu_k0;
    RkAttemptTraceState attempt_trace;
#if FULLMAG_HAS_MFEM_STACK
    PoissonStepStateSnapshot poisson_step_state{};
    std::vector<double> poisson_solution;
    std::vector<double> periodic_solution;
    std::vector<double> poisson_grid_function;
    std::vector<double> fem_bem_u1;
    std::vector<double> fem_bem_u2;
    std::vector<double> fem_bem_total;
    std::vector<double> fem_bem_boundary;
    std::vector<double> fem_bem_rhs;
    int fem_bem_last_u1_iterations = 0;
    int fem_bem_last_u2_iterations = 0;
    double fem_bem_last_u1_residual = 0.0;
    double fem_bem_last_u2_residual = 0.0;
#endif
    bool begun = false;
    bool finished = false;
};

RkStepTransaction::RkStepTransaction(Context &ctx)
    : ctx_(&ctx)
{
}

RkStepTransaction::~RkStepTransaction()
{
    if (impl_ != nullptr && impl_->begun && !impl_->finished) {
        std::string ignored;
        rollback(ignored);
    }
}

bool RkStepTransaction::begin(std::string &error)
{
    if (impl_ != nullptr && impl_->begun) {
        return true;
    }
    try {
        impl_ = std::make_unique<Impl>(*ctx_);
    } catch (const std::bad_alloc &) {
        error = "RK step transaction host snapshot allocation failed";
        return false;
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    if (!gpu_rk_capture_step_transaction_device(impl_->ctx, error)) {
        return false;
    }
#endif
    impl_->begun = true;
    active_step_transaction_context = &impl_->ctx;
    return true;
}

bool RkStepTransaction::rollback(std::string &error)
{
    if (impl_ == nullptr || !impl_->begun || impl_->finished) {
        return true;
    }
    bool device_ok = true;
#if FULLMAG_HAS_CUDA_RUNTIME
    device_ok = gpu_rk_restore_step_transaction_device(impl_->ctx, error);
#endif
    impl_->restore_host();
    impl_->finished = true;
    if (active_step_transaction_context == &impl_->ctx) {
        active_step_transaction_context = nullptr;
    }
    return device_ok;
}

void RkStepTransaction::commit()
{
    if (impl_ == nullptr) {
        return;
    }
    impl_->finished = true;
    if (active_step_transaction_context == &impl_->ctx) {
        active_step_transaction_context = nullptr;
    }
}

bool rk_restore_active_step_device_checkpoint(Context &ctx, std::string &error)
{
    if (active_step_transaction_context != &ctx) {
        return true;
    }
#if FULLMAG_HAS_CUDA_RUNTIME
    return gpu_rk_restore_step_transaction_device(ctx, error);
#else
    (void)error;
    return true;
#endif
}

struct RkAttemptCacheSnapshot::Impl {
    explicit Impl(Context &context)
        : ctx(context),
          anisotropy(context.anisotropy),
          magnetoelastic(context.magnetoelastic),
          exchange(context.exchange),
          demag(context.demag),
          zeeman(context.zeeman),
          dmi(context.dmi),
          effective_field(context.effective_field),
          oersted(context.oersted),
          gpu_hybrid_stage_m(context.gpu_state.device.demag_poisson.hybrid_stage_m_xyz),
          gpu_hybrid_demag(context.gpu_state.device.demag_poisson.hybrid_demag_xyz),
          gpu_hybrid_demag_energy(context.gpu_state.device.demag_poisson.hybrid_demag_energy_joules)
    {
#if FULLMAG_HAS_MFEM_STACK
        poisson_solution = capture_vector(context.poisson_demag.solution_vec);
        periodic_solution = capture_vector(context.poisson_demag.periodic_solution);
        poisson_grid_function = capture_vector(context.poisson_demag.gf_potential);
        if (auto *workspace = demag_fem_bem_workspace(context)) {
            fem_bem_u1 = capture_vector(workspace->u1.get());
            fem_bem_u2 = capture_vector(workspace->u2.get());
            fem_bem_total = capture_vector(workspace->total_potential.get());
        }
#endif
    }

    void restore()
    {
        const uint64_t demag_call_count = ctx.demag.call_count;
#if FULLMAG_HAS_MFEM_STACK
        const auto attempt_telemetry = capture_poisson_step_state(ctx.poisson_demag);
#endif
        ctx.anisotropy = anisotropy;
        ctx.magnetoelastic = magnetoelastic;
        ctx.exchange = exchange;
        ctx.demag = demag;
        ctx.demag.call_count = demag_call_count;
        ctx.zeeman = zeeman;
        ctx.dmi.h_interfacial_xyz = dmi.h_interfacial_xyz;
        ctx.dmi.h_bulk_xyz = dmi.h_bulk_xyz;
        ctx.dmi.energy_joules = dmi.energy_joules;
        ctx.effective_field = effective_field;
        ctx.oersted = oersted;
        ctx.gpu_state.device.demag_poisson.hybrid_stage_m_xyz = gpu_hybrid_stage_m;
        ctx.gpu_state.device.demag_poisson.hybrid_demag_xyz = gpu_hybrid_demag;
        ctx.gpu_state.device.demag_poisson.hybrid_demag_energy_joules =
            gpu_hybrid_demag_energy;
#if FULLMAG_HAS_MFEM_STACK
        restore_vector(ctx.poisson_demag.solution_vec, poisson_solution);
        restore_vector(ctx.poisson_demag.periodic_solution, periodic_solution);
        restore_vector(ctx.poisson_demag.gf_potential, poisson_grid_function);
        restore_poisson_step_state(ctx.poisson_demag, attempt_telemetry);
        if (auto *workspace = demag_fem_bem_workspace(ctx)) {
            restore_vector(workspace->u1.get(), fem_bem_u1);
            restore_vector(workspace->u2.get(), fem_bem_u2);
            restore_vector(workspace->total_potential.get(), fem_bem_total);
        }
#endif
    }

    Context &ctx;
    AnisotropyRuntimeState anisotropy;
    MagnetoelasticRuntimeState magnetoelastic;
    ExchangeRuntimeState exchange;
    DemagRuntimeState demag;
    ZeemanRuntimeState zeeman;
    DmiRuntimeState dmi;
    EffectiveFieldRuntimeState effective_field;
    OerstedRuntimeState oersted;
    std::vector<double> gpu_hybrid_stage_m;
    std::vector<double> gpu_hybrid_demag;
    double gpu_hybrid_demag_energy;
#if FULLMAG_HAS_MFEM_STACK
    std::vector<double> poisson_solution;
    std::vector<double> periodic_solution;
    std::vector<double> poisson_grid_function;
    std::vector<double> fem_bem_u1;
    std::vector<double> fem_bem_u2;
    std::vector<double> fem_bem_total;
#endif
};

RkAttemptCacheSnapshot::RkAttemptCacheSnapshot(Context &ctx)
    : impl_(std::make_unique<Impl>(ctx))
{
}

RkAttemptCacheSnapshot::~RkAttemptCacheSnapshot() = default;

void RkAttemptCacheSnapshot::restore_preserving_attempt_counters()
{
    impl_->restore();
}

} // namespace fullmag::fem

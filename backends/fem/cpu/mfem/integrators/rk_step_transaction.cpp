#include "cpu/mfem/integrators/rk_step_transaction.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_step_transaction_device.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#include <utility>
#include <vector>
#include <new>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <limits>

namespace fullmag::fem {
namespace {

thread_local Context *active_step_transaction_context = nullptr;

using SteadyClock = std::chrono::steady_clock;

uint64_t elapsed_wall_time_ns(SteadyClock::time_point start,
                              SteadyClock::time_point end)
{
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(end - start).count());
}

template <typename T>
uint64_t vector_payload_bytes(const std::vector<T> &values)
{
    constexpr uint64_t max_value = std::numeric_limits<uint64_t>::max();
    if (values.size() > max_value / sizeof(T)) {
        return max_value;
    }
    return static_cast<uint64_t>(values.size()) * sizeof(T);
}

void add_payload_bytes(uint64_t &total, uint64_t value)
{
    const uint64_t max_value = std::numeric_limits<uint64_t>::max();
    total = max_value - total < value ? max_value : total + value;
}

bool step_profile_enabled(const Context &ctx)
{
    const auto &timings = ctx.gpu_state.rk_phase_timings;
    if (timings.override_configured) {
        return timings.override_enabled;
    }
    const char *raw = std::getenv("FULLMAG_FEM_STEP_PROFILE");
    if (raw == nullptr || *raw == '\0') {
        return false;
    }
    return std::strcmp(raw, "1") == 0 ||
        std::strcmp(raw, "true") == 0 ||
        std::strcmp(raw, "TRUE") == 0 ||
        std::strcmp(raw, "on") == 0 ||
        std::strcmp(raw, "ON") == 0 ||
        std::strcmp(raw, "yes") == 0 ||
        std::strcmp(raw, "YES") == 0;
}

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
    explicit Impl(Context &context, bool profile_enabled)
        : ctx(context),
          profile_enabled(profile_enabled),
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
          stage_transport(context.stage_transport),
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

    uint64_t host_snapshot_payload_bytes() const
    {
        uint64_t bytes = 0;
        const auto add = [&bytes](uint64_t value) { add_payload_bytes(bytes, value); };
        add(vector_payload_bytes(state.m_xyz));
        add(vector_payload_bytes(attempt_trace.records));
        add(vector_payload_bytes(anisotropy.uniaxial_axis_x_field));
        add(vector_payload_bytes(anisotropy.uniaxial_axis_y_field));
        add(vector_payload_bytes(anisotropy.uniaxial_axis_z_field));
        add(vector_payload_bytes(anisotropy.h_uniaxial_xyz));
        add(vector_payload_bytes(anisotropy.h_cubic_xyz));
        add(vector_payload_bytes(magnetoelastic.strain_voigt));
        add(vector_payload_bytes(magnetoelastic.h_xyz));
        add(vector_payload_bytes(exchange.h_xyz));
        add(vector_payload_bytes(exchange.mfem.h_x));
        add(vector_payload_bytes(exchange.mfem.h_y));
        add(vector_payload_bytes(exchange.mfem.h_z));
        add(vector_payload_bytes(exchange.mfem.component_tmp));
        add(vector_payload_bytes(demag.h_xyz));
        add(vector_payload_bytes(demag.h_visual_xyz));
        add(vector_payload_bytes(demag.cached_xyz));
        add(vector_payload_bytes(demag.cached_visual_xyz));
        add(vector_payload_bytes(zeeman.h_ext_xyz));
        add(vector_payload_bytes(zeeman.h_drive_xyz));
        for (const auto &drive : zeeman.regional_drives) {
            add(vector_payload_bytes(drive.target_element_markers));
            add(vector_payload_bytes(drive.waveform.points));
            add(vector_payload_bytes(drive.geometry_nodes));
            add(vector_payload_bytes(drive.basis_h_xyz));
        }
        add(vector_payload_bytes(dmi.h_interfacial_xyz));
        add(vector_payload_bytes(dmi.h_bulk_xyz));
        add(vector_payload_bytes(effective_field.h_xyz));
        add(vector_payload_bytes(effective_field.h_visual_xyz));
        add(vector_payload_bytes(oersted.h_basis_per_ampere_xyz));
        add(vector_payload_bytes(oersted.h_xyz));
        add(vector_payload_bytes(stage_transport.torque_xyz_per_s));
        add(vector_payload_bytes(thermal_brown.xi_xyz));
        add(vector_payload_bytes(thermal_brown.h_xyz));
        add(vector_payload_bytes(gpu_hybrid_stage_m));
        add(vector_payload_bytes(gpu_hybrid_demag));
        add(vector_payload_bytes(cpu_k0));
        add(static_cast<uint64_t>(transfer_audit.hot_loop_violation_message.size()));
#if FULLMAG_HAS_MFEM_STACK
        add(vector_payload_bytes(poisson_solution));
        add(vector_payload_bytes(periodic_solution));
        add(vector_payload_bytes(poisson_grid_function));
        add(vector_payload_bytes(fem_bem_u1));
        add(vector_payload_bytes(fem_bem_u2));
        add(vector_payload_bytes(fem_bem_total));
        add(vector_payload_bytes(fem_bem_boundary));
        add(vector_payload_bytes(fem_bem_rhs));
#endif
        return bytes;
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
        ctx.stage_transport = stage_transport;
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
    bool profile_enabled = false;
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
    TransportStageRuntimeState stage_transport;
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
    const bool profile_enabled = step_profile_enabled(*ctx_);
    const auto begin_start = profile_enabled ? SteadyClock::now() : SteadyClock::time_point{};
    try {
        impl_ = std::make_unique<Impl>(*ctx_, profile_enabled);
    } catch (const std::bad_alloc &) {
        error = "RK step transaction host snapshot allocation failed";
        return false;
    }
    const auto host_capture_done = profile_enabled ? SteadyClock::now() : SteadyClock::time_point{};
    const uint64_t host_payload_bytes = profile_enabled
        ? impl_->host_snapshot_payload_bytes()
        : 0;
#if FULLMAG_HAS_CUDA_RUNTIME
    const auto device_capture_start = profile_enabled ? SteadyClock::now() : SteadyClock::time_point{};
    if (!gpu_rk_capture_step_transaction_device(impl_->ctx, error)) {
        return false;
    }
    if (profile_enabled) {
        const auto device_capture_done = SteadyClock::now();
        ctx_->stepper.transaction_telemetry.step_transaction_device_capture_enqueue_wall_time_ns +=
            elapsed_wall_time_ns(device_capture_start, device_capture_done);
    }
#endif
    if (profile_enabled) {
        const auto begin_done = SteadyClock::now();
        auto &telemetry = ctx_->stepper.transaction_telemetry;
        telemetry.step_transaction_begin_count += 1;
        telemetry.step_transaction_begin_wall_time_ns +=
            elapsed_wall_time_ns(begin_start, begin_done);
        telemetry.step_transaction_host_capture_wall_time_ns +=
            elapsed_wall_time_ns(begin_start, host_capture_done);
        telemetry.step_transaction_host_snapshot_payload_bytes += host_payload_bytes;
    }
    impl_->begun = true;
    active_step_transaction_context = &impl_->ctx;
    return true;
}

bool RkStepTransaction::rollback(std::string &error)
{
    if (impl_ == nullptr || !impl_->begun || impl_->finished) {
        return true;
    }
    const bool profile_enabled = impl_->profile_enabled;
    const auto rollback_start = profile_enabled ? SteadyClock::now() : SteadyClock::time_point{};
    bool device_ok = true;
#if FULLMAG_HAS_CUDA_RUNTIME
    const auto device_restore_start = profile_enabled ? SteadyClock::now() : SteadyClock::time_point{};
    device_ok = gpu_rk_restore_step_transaction_device(impl_->ctx, error);
    if (profile_enabled) {
        const auto device_restore_done = SteadyClock::now();
        ctx_->stepper.transaction_telemetry.step_transaction_device_restore_wall_time_ns +=
            elapsed_wall_time_ns(device_restore_start, device_restore_done);
    }
#endif
    const auto host_restore_start = profile_enabled ? SteadyClock::now() : SteadyClock::time_point{};
    impl_->restore_host();
    const auto host_restore_done = profile_enabled ? SteadyClock::now() : SteadyClock::time_point{};
    impl_->finished = true;
    if (active_step_transaction_context == &impl_->ctx) {
        active_step_transaction_context = nullptr;
    }
    if (profile_enabled) {
        const auto rollback_done = SteadyClock::now();
        auto &telemetry = ctx_->stepper.transaction_telemetry;
        telemetry.step_transaction_rollback_count += 1;
        telemetry.step_transaction_rollback_wall_time_ns +=
            elapsed_wall_time_ns(rollback_start, rollback_done);
        telemetry.step_transaction_host_restore_wall_time_ns +=
            elapsed_wall_time_ns(host_restore_start, host_restore_done);
        telemetry.step_transaction_host_restore_payload_bytes +=
            impl_->host_snapshot_payload_bytes();
    }
    return device_ok;
}

void RkStepTransaction::commit()
{
    if (impl_ == nullptr) {
        return;
    }
    const bool profile_enabled = impl_->profile_enabled;
    const auto commit_start = profile_enabled ? SteadyClock::now() : SteadyClock::time_point{};
    impl_->finished = true;
    if (active_step_transaction_context == &impl_->ctx) {
        active_step_transaction_context = nullptr;
    }
    if (profile_enabled) {
        const auto commit_done = SteadyClock::now();
        auto &telemetry = ctx_->stepper.transaction_telemetry;
        telemetry.step_transaction_commit_count += 1;
        telemetry.step_transaction_commit_wall_time_ns +=
            elapsed_wall_time_ns(commit_start, commit_done);
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
    explicit Impl(Context &context, bool profile_enabled)
        : ctx(context),
          profile_enabled(profile_enabled),
          anisotropy(context.anisotropy),
          magnetoelastic(context.magnetoelastic),
          exchange(context.exchange),
          demag(context.demag),
          zeeman(context.zeeman),
          dmi(context.dmi),
          effective_field(context.effective_field),
          oersted(context.oersted),
          stage_transport(context.stage_transport),
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
        ctx.stage_transport = stage_transport;
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

    uint64_t snapshot_payload_bytes() const
    {
        uint64_t bytes = 0;
        const auto add = [&bytes](uint64_t value) { add_payload_bytes(bytes, value); };
        add(vector_payload_bytes(anisotropy.uniaxial_axis_x_field));
        add(vector_payload_bytes(anisotropy.uniaxial_axis_y_field));
        add(vector_payload_bytes(anisotropy.uniaxial_axis_z_field));
        add(vector_payload_bytes(anisotropy.h_uniaxial_xyz));
        add(vector_payload_bytes(anisotropy.h_cubic_xyz));
        add(vector_payload_bytes(magnetoelastic.strain_voigt));
        add(vector_payload_bytes(magnetoelastic.h_xyz));
        add(vector_payload_bytes(exchange.h_xyz));
        add(vector_payload_bytes(exchange.mfem.h_x));
        add(vector_payload_bytes(exchange.mfem.h_y));
        add(vector_payload_bytes(exchange.mfem.h_z));
        add(vector_payload_bytes(exchange.mfem.component_tmp));
        add(vector_payload_bytes(demag.h_xyz));
        add(vector_payload_bytes(demag.h_visual_xyz));
        add(vector_payload_bytes(demag.cached_xyz));
        add(vector_payload_bytes(demag.cached_visual_xyz));
        add(vector_payload_bytes(zeeman.h_ext_xyz));
        add(vector_payload_bytes(zeeman.h_drive_xyz));
        for (const auto &drive : zeeman.regional_drives) {
            add(vector_payload_bytes(drive.target_element_markers));
            add(vector_payload_bytes(drive.waveform.points));
            add(vector_payload_bytes(drive.geometry_nodes));
            add(vector_payload_bytes(drive.basis_h_xyz));
        }
        add(vector_payload_bytes(dmi.h_interfacial_xyz));
        add(vector_payload_bytes(dmi.h_bulk_xyz));
        add(vector_payload_bytes(effective_field.h_xyz));
        add(vector_payload_bytes(effective_field.h_visual_xyz));
        add(vector_payload_bytes(oersted.h_basis_per_ampere_xyz));
        add(vector_payload_bytes(oersted.h_xyz));
        add(vector_payload_bytes(stage_transport.torque_xyz_per_s));
        add(vector_payload_bytes(gpu_hybrid_stage_m));
        add(vector_payload_bytes(gpu_hybrid_demag));
#if FULLMAG_HAS_MFEM_STACK
        add(vector_payload_bytes(poisson_solution));
        add(vector_payload_bytes(periodic_solution));
        add(vector_payload_bytes(poisson_grid_function));
        add(vector_payload_bytes(fem_bem_u1));
        add(vector_payload_bytes(fem_bem_u2));
        add(vector_payload_bytes(fem_bem_total));
#endif
        return bytes;
    }

    Context &ctx;
    bool profile_enabled = false;
    AnisotropyRuntimeState anisotropy;
    MagnetoelasticRuntimeState magnetoelastic;
    ExchangeRuntimeState exchange;
    DemagRuntimeState demag;
    ZeemanRuntimeState zeeman;
    DmiRuntimeState dmi;
    EffectiveFieldRuntimeState effective_field;
    OerstedRuntimeState oersted;
    TransportStageRuntimeState stage_transport;
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
    : impl_(nullptr)
{
    const bool profile_enabled = step_profile_enabled(ctx);
    const auto capture_start = profile_enabled ? SteadyClock::now() : SteadyClock::time_point{};
    impl_ = std::make_unique<Impl>(ctx, profile_enabled);
    if (profile_enabled) {
        const auto capture_done = SteadyClock::now();
        auto &telemetry = ctx.stepper.transaction_telemetry;
        telemetry.attempt_cache_capture_count += 1;
        telemetry.attempt_cache_capture_wall_time_ns +=
            elapsed_wall_time_ns(capture_start, capture_done);
        telemetry.attempt_cache_snapshot_payload_bytes += impl_->snapshot_payload_bytes();
    }
}

RkAttemptCacheSnapshot::~RkAttemptCacheSnapshot() = default;

void RkAttemptCacheSnapshot::restore_preserving_attempt_counters()
{
    const bool profile_enabled = impl_->profile_enabled;
    const auto restore_start = profile_enabled ? SteadyClock::now() : SteadyClock::time_point{};
    impl_->restore();
    if (profile_enabled) {
        const auto restore_done = SteadyClock::now();
        auto &telemetry = impl_->ctx.stepper.transaction_telemetry;
        telemetry.attempt_cache_restore_count += 1;
        telemetry.attempt_cache_restore_wall_time_ns +=
            elapsed_wall_time_ns(restore_start, restore_done);
        telemetry.attempt_cache_restore_payload_bytes += impl_->snapshot_payload_bytes();
    }
}

} // namespace fullmag::fem

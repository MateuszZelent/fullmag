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

#if defined(__linux__) || defined(__APPLE__)
#include <sys/resource.h>
#endif

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

uint64_t process_peak_rss_bytes()
{
#if defined(__linux__) || defined(__APPLE__)
    rusage usage{};
    if (getrusage(RUSAGE_SELF, &usage) != 0 || usage.ru_maxrss < 0) {
        return 0;
    }
#if defined(__APPLE__)
    return static_cast<uint64_t>(usage.ru_maxrss);
#else
    constexpr uint64_t bytes_per_kibibyte = 1024;
    const auto peak_kibibytes = static_cast<uint64_t>(usage.ru_maxrss);
    return peak_kibibytes >
            std::numeric_limits<uint64_t>::max() / bytes_per_kibibyte
        ? std::numeric_limits<uint64_t>::max()
        : peak_kibibytes * bytes_per_kibibyte;
#endif
#else
    return 0;
#endif
}

#if FULLMAG_HAS_MFEM_STACK
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

void capture_vector_into(const mfem::Vector *vector, std::vector<double> &snapshot)
{
    if (vector == nullptr) {
        snapshot.clear();
        return;
    }
    snapshot.resize(static_cast<size_t>(vector->Size()));
    std::copy(vector->GetData(), vector->GetData() + vector->Size(), snapshot.begin());
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

/*
 * CPU RK keeps published fields in one generation and evaluates the trial in
 * another.  Moving a generation across the transaction boundary is a vector
 * swap: no payload is copied and the rejected generation becomes reusable
 * storage for the next attempt.
 */
struct CpuPublishedFieldBuffers {
    std::vector<double> anisotropy_uniaxial;
    std::vector<double> anisotropy_cubic;
    std::vector<double> magnetoelastic;
    std::vector<double> exchange;
    std::vector<double> demag;
    std::vector<double> demag_visual;
    std::vector<double> demag_cached;
    std::vector<double> demag_cached_visual;
    std::vector<double> zeeman_drive;
    std::vector<double> dmi_interfacial;
    std::vector<double> dmi_bulk;
    std::vector<double> effective;
    std::vector<double> effective_visual;
    std::vector<double> oersted;
    std::vector<double> transport;
    std::vector<double> thermal_draw;
    std::vector<double> thermal_field;

    uint64_t prepare_like(const Context &ctx)
    {
        uint64_t allocations = 0;
        const auto resize = [&allocations](auto &target, const auto &source) {
            if (source.size() > target.capacity()) {
                ++allocations;
            }
            target.resize(source.size());
        };
        resize(anisotropy_uniaxial, ctx.anisotropy.h_uniaxial_xyz);
        resize(anisotropy_cubic, ctx.anisotropy.h_cubic_xyz);
        resize(magnetoelastic, ctx.magnetoelastic.h_xyz);
        resize(exchange, ctx.exchange.h_xyz);
        resize(demag, ctx.demag.h_xyz);
        resize(demag_visual, ctx.demag.h_visual_xyz);
        resize(demag_cached, ctx.demag.cached_xyz);
        resize(demag_cached_visual, ctx.demag.cached_visual_xyz);
        resize(zeeman_drive, ctx.zeeman.h_drive_xyz);
        resize(dmi_interfacial, ctx.dmi.h_interfacial_xyz);
        resize(dmi_bulk, ctx.dmi.h_bulk_xyz);
        resize(effective, ctx.effective_field.h_xyz);
        resize(effective_visual, ctx.effective_field.h_visual_xyz);
        resize(oersted, ctx.oersted.h_xyz);
        resize(transport, ctx.stage_transport.torque_xyz_per_s);
        resize(thermal_draw, ctx.thermal_brown.xi_xyz);
        resize(thermal_field, ctx.thermal_brown.h_xyz);
        return allocations;
    }

    void swap_with(Context &ctx) noexcept
    {
        anisotropy_uniaxial.swap(ctx.anisotropy.h_uniaxial_xyz);
        anisotropy_cubic.swap(ctx.anisotropy.h_cubic_xyz);
        magnetoelastic.swap(ctx.magnetoelastic.h_xyz);
        exchange.swap(ctx.exchange.h_xyz);
        demag.swap(ctx.demag.h_xyz);
        demag_visual.swap(ctx.demag.h_visual_xyz);
        demag_cached.swap(ctx.demag.cached_xyz);
        demag_cached_visual.swap(ctx.demag.cached_visual_xyz);
        zeeman_drive.swap(ctx.zeeman.h_drive_xyz);
        dmi_interfacial.swap(ctx.dmi.h_interfacial_xyz);
        dmi_bulk.swap(ctx.dmi.h_bulk_xyz);
        effective.swap(ctx.effective_field.h_xyz);
        effective_visual.swap(ctx.effective_field.h_visual_xyz);
        oersted.swap(ctx.oersted.h_xyz);
        transport.swap(ctx.stage_transport.torque_xyz_per_s);
        thermal_draw.swap(ctx.thermal_brown.xi_xyz);
        thermal_field.swap(ctx.thermal_brown.h_xyz);
    }
};

struct CpuStepScalarSnapshot {
    FemBasePlanRuntimeState base_plan{};
    AdaptiveDtRuntimeState adaptive_dt{};
    StageCompletionRuntimeState stage_completion{};
    uint64_t step_count = 0;
    double current_time = 0.0;
    bool exchange_ready = false;
    bool demag_cache_valid = false;
    double demag_last_refresh_time = -1.0;
    double demag_cached_robin_boundary_energy = 0.0;
    double anisotropy_energy_joules = 0.0;
    double magnetoelastic_energy_joules = 0.0;
    double dmi_energy_joules = 0.0;
    double zeeman_last_evaluation_time_s = 0.0;
    uint64_t zeeman_regional_drive_revision = 0;
    uint64_t oersted_stage_identity = 0;
    uint64_t oersted_stage_source_state_revision = 0;
    bool oersted_stage_attempt_active = false;
    uint64_t oersted_stage_attempt_target_step = 0;
    uint64_t oersted_stage_attempt_identity = 0;
    double oersted_stage_attempt_time_start_s = 0.0;
    double oersted_stage_attempt_dt_seconds = 0.0;
    uint64_t transport_stage_identity = 0;
    uint64_t transport_stage_source_state_revision = 0;
    bool transport_stage_attempt_active = false;
    uint64_t transport_stage_attempt_target_step = 0;
    uint64_t transport_stage_attempt_identity = 0;
    double transport_stage_attempt_time_start_s = 0.0;
    double transport_stage_attempt_dt_seconds = 0.0;
    double thermal_sigma = 0.0;
    double thermal_last_refresh_time = -1.0;
    double thermal_last_refresh_dt = -1.0;
    uint64_t thermal_accepted_interval_index = UINT64_MAX;
    bool thermal_raw_draw_valid = false;
};

} // namespace

struct RkStepTransaction::Impl {
    explicit Impl(Context &context)
        : ctx(context)
    {
    }

    void prepare_cpu_storage()
    {
        if (!cpu_storage_prepared) {
            cpu_storage_allocation_count += cpu_buffers.prepare_like(ctx);
            cpu_storage_prepared = true;
        }
    }

    void capture_cpu_host()
    {
        prepare_cpu_storage();
        cpu_scalars.base_plan = ctx.base_plan;
        cpu_scalars.adaptive_dt = ctx.adaptive_dt;
        cpu_scalars.stage_completion = ctx.stage_completion;
        cpu_scalars.step_count = ctx.state.step_count;
        cpu_scalars.current_time = ctx.state.current_time;
        cpu_scalars.exchange_ready = ctx.exchange.mfem.ready;
        cpu_scalars.demag_cache_valid = ctx.demag.cache_valid;
        cpu_scalars.demag_last_refresh_time = ctx.demag.last_refresh_time;
        cpu_scalars.demag_cached_robin_boundary_energy =
            ctx.demag.cached_robin_boundary_energy;
        cpu_scalars.anisotropy_energy_joules = ctx.anisotropy.energy_joules;
        cpu_scalars.magnetoelastic_energy_joules =
            ctx.magnetoelastic.energy_joules;
        cpu_scalars.dmi_energy_joules = ctx.dmi.energy_joules;
        cpu_scalars.zeeman_last_evaluation_time_s =
            ctx.zeeman.last_evaluation_time_s;
        cpu_scalars.zeeman_regional_drive_revision =
            ctx.zeeman.regional_drive_revision;
        cpu_scalars.oersted_stage_identity = ctx.oersted.stage_identity;
        cpu_scalars.oersted_stage_source_state_revision =
            ctx.oersted.stage_source_state_revision;
        cpu_scalars.oersted_stage_attempt_active =
            ctx.oersted.stage_attempt_active;
        cpu_scalars.oersted_stage_attempt_target_step =
            ctx.oersted.stage_attempt_target_step;
        cpu_scalars.oersted_stage_attempt_identity =
            ctx.oersted.stage_attempt_identity;
        cpu_scalars.oersted_stage_attempt_time_start_s =
            ctx.oersted.stage_attempt_time_start_s;
        cpu_scalars.oersted_stage_attempt_dt_seconds =
            ctx.oersted.stage_attempt_dt_seconds;
        cpu_scalars.transport_stage_identity = ctx.stage_transport.stage_identity;
        cpu_scalars.transport_stage_source_state_revision =
            ctx.stage_transport.stage_source_state_revision;
        cpu_scalars.transport_stage_attempt_active =
            ctx.stage_transport.stage_attempt_active;
        cpu_scalars.transport_stage_attempt_target_step =
            ctx.stage_transport.stage_attempt_target_step;
        cpu_scalars.transport_stage_attempt_identity =
            ctx.stage_transport.stage_attempt_identity;
        cpu_scalars.transport_stage_attempt_time_start_s =
            ctx.stage_transport.stage_attempt_time_start_s;
        cpu_scalars.transport_stage_attempt_dt_seconds =
            ctx.stage_transport.stage_attempt_dt_seconds;
        cpu_scalars.thermal_sigma = ctx.thermal_brown.sigma;
        cpu_scalars.thermal_last_refresh_time =
            ctx.thermal_brown.last_refresh_time;
        cpu_scalars.thermal_last_refresh_dt = ctx.thermal_brown.last_refresh_dt;
        cpu_scalars.thermal_accepted_interval_index =
            ctx.thermal_brown.accepted_interval_index;
        cpu_scalars.thermal_raw_draw_valid = ctx.thermal_brown.raw_draw_valid;
        cpu_buffers.swap_with(ctx);
    }

    void capture_host()
    {
        minimal_cpu_journal = !ctx.gpu_state.device.lifecycle.allocated;
        if (minimal_cpu_journal) {
            capture_cpu_host();
            return;
        }
        base_plan = ctx.base_plan;
        adaptive_dt = ctx.adaptive_dt;
        anisotropy = ctx.anisotropy;
        magnetoelastic = ctx.magnetoelastic;
        stage_completion = ctx.stage_completion;
        state = ctx.state;
        exchange = ctx.exchange;
        demag = ctx.demag;
        zeeman = ctx.zeeman;
        dmi = ctx.dmi;
        effective_field = ctx.effective_field;
        oersted = ctx.oersted;
        stage_transport = ctx.stage_transport;
        thermal_brown = ctx.thermal_brown;
        transfer_audit = ctx.transfer_audit.audit;
        gpu_residency = ctx.gpu_state.device.residency;
        gpu_fsal_valid = ctx.gpu_state.device.rk.fsal_valid;
        gpu_hybrid_stage_m = ctx.gpu_state.device.demag_poisson.hybrid_stage_m_xyz;
        gpu_hybrid_demag = ctx.gpu_state.device.demag_poisson.hybrid_demag_xyz;
        gpu_hybrid_demag_energy =
            ctx.gpu_state.device.demag_poisson.hybrid_demag_energy_joules;
        phase_timings = capture_phase_timings(ctx.gpu_state.rk_phase_timings);
        cpu_fsal_valid = ctx.stepper.workspace.fsal_valid;
        cpu_k0 = ctx.stepper.workspace.k[0];
        attempt_trace = ctx.stepper.attempt_trace;
#if FULLMAG_HAS_MFEM_STACK
        poisson_step_state = capture_poisson_step_state(ctx.poisson_demag);
        capture_vector_into(ctx.poisson_demag.solution_vec, poisson_solution);
        capture_vector_into(ctx.poisson_demag.periodic_solution, periodic_solution);
        capture_vector_into(ctx.poisson_demag.gf_potential, poisson_grid_function);
        if (auto *workspace = demag_fem_bem_workspace(ctx)) {
            capture_vector_into(workspace->u1.get(), fem_bem_u1);
            capture_vector_into(workspace->u2.get(), fem_bem_u2);
            capture_vector_into(workspace->total_potential.get(), fem_bem_total);
            capture_vector_into(workspace->boundary_values_global.get(), fem_bem_boundary);
            capture_vector_into(workspace->laplace_rhs.get(), fem_bem_rhs);
            fem_bem_last_u1_iterations = workspace->last_u1_iterations;
            fem_bem_last_u2_iterations = workspace->last_u2_iterations;
            fem_bem_last_u1_residual = workspace->last_u1_residual;
            fem_bem_last_u2_residual = workspace->last_u2_residual;
        } else {
            fem_bem_u1.clear();
            fem_bem_u2.clear();
            fem_bem_total.clear();
            fem_bem_boundary.clear();
            fem_bem_rhs.clear();
            fem_bem_last_u1_iterations = 0;
            fem_bem_last_u2_iterations = 0;
            fem_bem_last_u1_residual = 0.0;
            fem_bem_last_u2_residual = 0.0;
        }
#endif
    }

    void prepare_for_begin(bool enabled)
    {
        profile_enabled = enabled;
        capture_host();
        begun = false;
        finished = false;
    }

    uint64_t host_snapshot_payload_bytes() const
    {
        if (minimal_cpu_journal) {
            return 0;
        }
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
        if (minimal_cpu_journal) {
            if (ctx.state.step_count != cpu_scalars.step_count) {
                ctx.state.m_xyz.swap(ctx.stepper.workspace.m_candidate);
            }
            cpu_buffers.swap_with(ctx);
            const uint64_t rejected_steps = ctx.adaptive_dt.rejected_steps;
            ctx.base_plan = cpu_scalars.base_plan;
            ctx.adaptive_dt = cpu_scalars.adaptive_dt;
            ctx.adaptive_dt.rejected_steps = rejected_steps;
            ctx.stage_completion = cpu_scalars.stage_completion;
            ctx.state.step_count = cpu_scalars.step_count;
            ctx.state.current_time = cpu_scalars.current_time;
            ctx.exchange.mfem.ready = cpu_scalars.exchange_ready;
            ctx.demag.cache_valid = cpu_scalars.demag_cache_valid;
            ctx.demag.last_refresh_time = cpu_scalars.demag_last_refresh_time;
            ctx.demag.cached_robin_boundary_energy =
                cpu_scalars.demag_cached_robin_boundary_energy;
            ctx.anisotropy.energy_joules =
                cpu_scalars.anisotropy_energy_joules;
            ctx.magnetoelastic.energy_joules =
                cpu_scalars.magnetoelastic_energy_joules;
            ctx.dmi.energy_joules = cpu_scalars.dmi_energy_joules;
            ctx.zeeman.last_evaluation_time_s =
                cpu_scalars.zeeman_last_evaluation_time_s;
            ctx.zeeman.regional_drive_revision =
                cpu_scalars.zeeman_regional_drive_revision;
            ctx.oersted.stage_identity = cpu_scalars.oersted_stage_identity;
            ctx.oersted.stage_source_state_revision =
                cpu_scalars.oersted_stage_source_state_revision;
            ctx.oersted.stage_attempt_active =
                cpu_scalars.oersted_stage_attempt_active;
            ctx.oersted.stage_attempt_target_step =
                cpu_scalars.oersted_stage_attempt_target_step;
            ctx.oersted.stage_attempt_identity =
                cpu_scalars.oersted_stage_attempt_identity;
            ctx.oersted.stage_attempt_time_start_s =
                cpu_scalars.oersted_stage_attempt_time_start_s;
            ctx.oersted.stage_attempt_dt_seconds =
                cpu_scalars.oersted_stage_attempt_dt_seconds;
            ctx.stage_transport.stage_identity =
                cpu_scalars.transport_stage_identity;
            ctx.stage_transport.stage_source_state_revision =
                cpu_scalars.transport_stage_source_state_revision;
            ctx.stage_transport.stage_attempt_active =
                cpu_scalars.transport_stage_attempt_active;
            ctx.stage_transport.stage_attempt_target_step =
                cpu_scalars.transport_stage_attempt_target_step;
            ctx.stage_transport.stage_attempt_identity =
                cpu_scalars.transport_stage_attempt_identity;
            ctx.stage_transport.stage_attempt_time_start_s =
                cpu_scalars.transport_stage_attempt_time_start_s;
            ctx.stage_transport.stage_attempt_dt_seconds =
                cpu_scalars.transport_stage_attempt_dt_seconds;
            ctx.thermal_brown.sigma = cpu_scalars.thermal_sigma;
            ctx.thermal_brown.last_refresh_time =
                cpu_scalars.thermal_last_refresh_time;
            ctx.thermal_brown.last_refresh_dt =
                cpu_scalars.thermal_last_refresh_dt;
            ctx.thermal_brown.accepted_interval_index =
                cpu_scalars.thermal_accepted_interval_index;
            ctx.thermal_brown.raw_draw_valid =
                cpu_scalars.thermal_raw_draw_valid;
            ctx.stepper.workspace.fsal_valid = false;
#if FULLMAG_HAS_MFEM_STACK
            ctx.poisson_demag.fresh_initial_guess_required = true;
            if (auto *workspace = demag_fem_bem_workspace(ctx)) {
                workspace->fresh_initial_guess_required = true;
            }
#endif
            return;
        }
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
        // Endpoint tokens are attempt-local and are never valid across a
        // transaction rollback, even when the pre-step FSAL k0 is restored.
        ctx.gpu_state.device.rk.endpoint_valid = false;
        ctx.gpu_state.device.rk.endpoint_consumed = true;
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
    bool minimal_cpu_journal = false;
    bool cpu_storage_prepared = false;
    uint64_t cpu_storage_allocation_count = 0;
    CpuPublishedFieldBuffers cpu_buffers{};
    CpuStepScalarSnapshot cpu_scalars{};
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
    bool gpu_fsal_valid = false;
    std::vector<double> gpu_hybrid_stage_m;
    std::vector<double> gpu_hybrid_demag;
    double gpu_hybrid_demag_energy = 0.0;
    PhaseTimingSnapshot phase_timings;
    bool cpu_fsal_valid = false;
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

struct RkStepTransactionJournal {
    std::unique_ptr<RkStepTransaction::Impl> snapshot;
};

void RkStepTransactionJournalDeleter::operator()(
    RkStepTransactionJournal *journal) const noexcept
{
    delete journal;
}

void rk_step_transaction_prepare_workspace(Context &ctx)
{
    auto &workspace = ctx.stepper.workspace;
    if (workspace.transaction_journal == nullptr) {
        workspace.transaction_journal.reset(new RkStepTransactionJournal());
    }
    if (workspace.transaction_journal->snapshot == nullptr) {
        workspace.transaction_journal->snapshot =
            std::make_unique<RkStepTransaction::Impl>(ctx);
    }
    if (!ctx.gpu_state.device.lifecycle.allocated) {
        workspace.transaction_journal->snapshot->prepare_cpu_storage();
    }
}

void rk_step_transaction_reset_workspace(StepperWorkspace &workspace) noexcept
{
    workspace.transaction_journal.reset();
}

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
    uint64_t cpu_allocations_before = 0;
    if (ctx_->stepper.workspace.transaction_journal != nullptr &&
        ctx_->stepper.workspace.transaction_journal->snapshot != nullptr) {
        cpu_allocations_before = ctx_->stepper.workspace.transaction_journal
            ->snapshot->cpu_storage_allocation_count;
    }
    try {
        rk_step_transaction_prepare_workspace(*ctx_);
        journal_ = ctx_->stepper.workspace.transaction_journal.get();
        if (journal_->snapshot != nullptr &&
            journal_->snapshot->begun && !journal_->snapshot->finished) {
            error = "RK step transaction is already active for this Context";
            return false;
        }
        journal_->snapshot->prepare_for_begin(profile_enabled);
        impl_ = journal_->snapshot.get();
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
        impl_->restore_host();
        impl_->finished = true;
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
        telemetry.step_transaction_cpu_snapshot_allocation_count +=
            impl_->cpu_storage_allocation_count - cpu_allocations_before;
        telemetry.step_transaction_peak_rss_bytes = std::max(
            telemetry.step_transaction_peak_rss_bytes,
            process_peak_rss_bytes());
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
#if FULLMAG_HAS_CUDA_RUNTIME
    if (ctx_->gpu_state.device.lifecycle.allocated) {
        // The minimal device journal restores only authoritative state. Trial
        // fields must not be published, and the next Poisson application must
        // cold-start instead of reusing a failed candidate's guess.
        ctx_->gpu_state.device.fields.accepted_observables_valid = false;
        ctx_->gpu_state.device.fields.accepted_observables_step =
            ctx_->state.step_count;
        ctx_->poisson_demag.fresh_initial_guess_required = true;
    }
#endif
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
        telemetry.step_transaction_peak_rss_bytes = std::max(
            telemetry.step_transaction_peak_rss_bytes,
            process_peak_rss_bytes());
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
#if FULLMAG_HAS_CUDA_RUNTIME
    if (ctx_->gpu_state.device.lifecycle.allocated) {
        ctx_->gpu_state.device.fields.accepted_observables_valid = true;
        ctx_->gpu_state.device.fields.accepted_observables_step =
            ctx_->state.step_count;
    }
#endif
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
        telemetry.step_transaction_peak_rss_bytes = std::max(
            telemetry.step_transaction_peak_rss_bytes,
            process_peak_rss_bytes());
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
        : ctx(context)
    {
    }

    void capture()
    {
        // Trial fields are overwritten by the next attempt.  Only cache
        // validity crosses the retry boundary; no O(N) payload is captured.
    }

    void restore()
    {
        ctx.exchange.mfem.ready = false;
        ctx.demag.cache_valid = false;
#if FULLMAG_HAS_MFEM_STACK
        ctx.poisson_demag.fresh_initial_guess_required = true;
        if (auto *workspace = demag_fem_bem_workspace(ctx)) {
            workspace->fresh_initial_guess_required = true;
        }
#endif
    }

    uint64_t snapshot_payload_bytes() const
    {
        return 0;
    }

    Context &ctx;
};

RkAttemptCacheSnapshot::RkAttemptCacheSnapshot(Context &ctx)
    : RkAttemptCacheSnapshot(ctx, true)
{
}

RkAttemptCacheSnapshot::RkAttemptCacheSnapshot(Context &ctx, bool capture_now)
    : impl_(nullptr)
{
    const bool profile_enabled = step_profile_enabled(ctx);
    const auto capture_start =
        capture_now && profile_enabled ? SteadyClock::now() : SteadyClock::time_point{};
    impl_ = std::make_unique<Impl>(ctx);
    if (capture_now) {
        impl_->capture();
        if (profile_enabled) {
            const auto capture_done = SteadyClock::now();
            auto &telemetry = ctx.stepper.transaction_telemetry;
            telemetry.attempt_cache_capture_count += 1;
            telemetry.attempt_cache_capture_wall_time_ns +=
                elapsed_wall_time_ns(capture_start, capture_done);
            telemetry.attempt_cache_snapshot_payload_bytes += impl_->snapshot_payload_bytes();
        }
    }
}

bool RkAttemptCacheSnapshot::prepare(std::string &error)
{
    if (impl_ == nullptr) {
        error = "RK attempt cache snapshot is not initialized";
        return false;
    }
    try {
        impl_->capture();
    } catch (const std::bad_alloc &) {
        error = "RK attempt cache snapshot preparation allocation failed";
        return false;
    }
    return true;
}

bool RkAttemptCacheSnapshot::capture(std::string &error)
{
    if (impl_ == nullptr) {
        error = "RK attempt cache snapshot is not initialized";
        return false;
    }
    const bool profile_enabled = step_profile_enabled(impl_->ctx);
    const auto capture_start = profile_enabled ? SteadyClock::now() : SteadyClock::time_point{};
    try {
        impl_->capture();
    } catch (const std::bad_alloc &) {
        error = "RK attempt cache snapshot capture allocation failed";
        return false;
    }
    if (profile_enabled) {
        const auto capture_done = SteadyClock::now();
        auto &telemetry = impl_->ctx.stepper.transaction_telemetry;
        telemetry.attempt_cache_capture_count += 1;
        telemetry.attempt_cache_capture_wall_time_ns +=
            elapsed_wall_time_ns(capture_start, capture_done);
        telemetry.attempt_cache_snapshot_payload_bytes += impl_->snapshot_payload_bytes();
    }
    return true;
}

RkAttemptCacheSnapshot::~RkAttemptCacheSnapshot() = default;

void RkAttemptCacheSnapshot::restore_preserving_attempt_counters()
{
    const bool profile_enabled = step_profile_enabled(impl_->ctx);
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

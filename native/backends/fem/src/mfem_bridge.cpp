#include "context.hpp"
#include "cpu/mfem/interactions/anisotropy.hpp"
#include "cpu/mfem/interactions/demag.hpp"
#include "cpu/mfem/interactions/demag_fem_bem.hpp"
#include "cpu/mfem/interactions/demag_poisson.hpp"
#include "cpu/mfem/interactions/dmi.hpp"
#include "cpu/mfem/interactions/effective_field.hpp"
#include "cpu/mfem/interactions/exchange.hpp"
#include "cpu/mfem/interactions/magnetoelastic.hpp"
#include "cpu/mfem/interactions/oersted.hpp"
#include "cpu/mfem/interactions/stt.hpp"
#include "cpu/mfem/interactions/thermal_brown.hpp"
#include "cpu/mfem/interactions/zeeman.hpp"
#include "cpu/mfem/integrators/adaptive_dt.hpp"
#include "cpu/mfem/integrators/llg_rhs.hpp"
#include "cpu/mfem/integrators/rk_stage_rhs.hpp"
#include "cpu/mfem/runtime/aos_field.hpp"
#include "cpu/mfem/runtime/cpu_threads.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "cpu/mfem/runtime/step_metrics.hpp"
#include "gpu_rk.hpp"
#include "transfer_audit.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <tuple>

#ifdef _OPENMP
#include <omp.h>
#endif

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kMu0 = 4.0e-7 * kPi;
constexpr double kGeomEps = 1e-30;
constexpr double kPoissonAbsResidualTol = 1e-6;
constexpr int kInterruptPollStride = 256;

using Vec3 = std::array<double, 3>;
using SteadyClock = std::chrono::steady_clock;

uint64_t elapsed_ns(const SteadyClock::time_point &start) {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            SteadyClock::now() - start)
            .count());
}

class ScopedPhaseTimer {
public:
    explicit ScopedPhaseTimer(uint64_t *accumulator)
        : accumulator_(accumulator) {
        if (accumulator_ != nullptr) {
            start_ = SteadyClock::now();
        }
    }

    ~ScopedPhaseTimer() {
        if (accumulator_ != nullptr) {
            *accumulator_ += elapsed_ns(start_);
        }
    }

private:
    uint64_t *accumulator_ = nullptr;
    SteadyClock::time_point start_{};
};

void apply_phase_timings(
    fullmag_fem_step_stats &stats,
    const PhaseTimings &timings)
{
    stats.exchange_wall_time_ns = timings.exchange_wall_time_ns;
    fill_demag_poisson_phase_stats(timings.demag, stats);
    stats.rhs_wall_time_ns = timings.rhs_wall_time_ns;
    stats.extra_energy_wall_time_ns = timings.extra_energy_wall_time_ns;
    stats.snapshot_wall_time_ns = timings.snapshot_wall_time_ns;
}

std::optional<int> selected_cuda_device_from_env() {
    const char *specific = std::getenv("FULLMAG_FEM_GPU_INDEX");
    const char *generic = std::getenv("FULLMAG_CUDA_DEVICE_INDEX");
    const char *raw = specific != nullptr ? specific : generic;
    if (raw == nullptr || *raw == '\0') {
        return std::nullopt;
    }
    char *end = nullptr;
    const long parsed = std::strtol(raw, &end, 10);
    if (end == raw || *end != '\0' || parsed < 0) {
        return std::nullopt;
    }
    return static_cast<int>(parsed);
}

} // namespace

namespace {

bool env_flag_enabled(const char *name) {
    const char *raw = std::getenv(name);
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

void debug_checkpoint(const char *stage) {
    if (!env_flag_enabled("FULLMAG_FEM_DEBUG_STARTUP")) {
        return;
    }
    std::fprintf(stderr, "[fullmag_fem][debug] %s\n", stage);
    std::fflush(stderr);
}

double dot3(const Vec3 &a, const Vec3 &b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

Vec3 cross3(const Vec3 &a, const Vec3 &b) {
    return {
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    };
}

double scalar_field_value(
    const std::vector<double> &field,
    size_t index,
    double fallback)
{
    return index < field.size() ? field[index] : fallback;
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

bool is_fully_magnetic(const Context &ctx) {
    if (ctx.element_markers.empty()) {
        return true;
    }
    const uint32_t first = ctx.element_markers.front();
    return std::all_of(
        ctx.element_markers.begin(),
        ctx.element_markers.end(),
        [first](uint32_t marker) { return marker == first; });
}

uint64_t vector_bytes(const mfem::Vector &vector) {
    return static_cast<uint64_t>(std::max(vector.Size(), 0)) * sizeof(double);
}

const double *audited_host_read(const mfem::Vector &vector) {
    record_mfem_host_read(vector_bytes(vector));
    return vector.HostRead();
}

double *audited_host_write(mfem::Vector &vector) {
    record_mfem_host_write(vector_bytes(vector));
    return vector.HostWrite();
}

double *audited_host_read_write(mfem::Vector &vector) {
    record_mfem_host_read_write(vector_bytes(vector));
    return vector.HostReadWrite();
}

void copy_host_vector_to_mfem(const std::vector<double> &src, mfem::Vector &dst) {
    dst.SetSize(static_cast<int>(src.size()));
    dst.UseDevice(true);
    double *host = audited_host_write(dst);
    for (size_t i = 0; i < src.size(); ++i) {
        host[static_cast<int>(i)] = src[i];
    }
}

void copy_mfem_vector_to_host(const mfem::Vector &src, std::vector<double> &dst) {
    const int n = src.Size();
    dst.resize(static_cast<size_t>(n));
    const double *host = audited_host_read(src);
    for (int i = 0; i < n; ++i) {
        dst[static_cast<size_t>(i)] = host[i];
    }
}

double dot_host_vectors(const std::vector<double> &a, const std::vector<double> &b) {
    double value = 0.0;
    for (size_t i = 0; i < a.size(); ++i) {
        value += a[i] * b[i];
    }
    return value;
}

} // namespace

bool context_initialize_mfem(Context &ctx, std::string &error) {
    try {
        debug_checkpoint("context_initialize_mfem:enter");
        // mfem::Device is a process-global singleton; creating it more than once
        // triggers an abort ("mfem::Device is already configured!").  We use
        // std::call_once so that multi-stage simulations AND parallel test
        // threads share the same device safely.
        static std::once_flag s_mfem_device_once;
#if FULLMAG_HAS_CUDA_RUNTIME
        // FEM-030: use plan override > env var > compiled default.
        const char *device_config = configured_mfem_device_string(ctx);
        const bool use_gpu_device = is_gpu_device_string(device_config);
        if (use_gpu_device) {
            // FEM-029: honour explicit gpu_device_index from the plan; fall
            // back to the env-var path, then to device 0.
            const int selected_device = (ctx.gpu_device_index >= 0)
                ? ctx.gpu_device_index
                : selected_cuda_device_from_env().value_or(0);
            int device_count = 0;
            cudaError_t cuda_err = cudaGetDeviceCount(&device_count);
            if (cuda_err != cudaSuccess || device_count <= 0) {
                error = "MFEM CUDA backend requested but no CUDA device is available";
                return false;
            }
            if (selected_device < 0 || selected_device >= device_count) {
                error = "requested FEM GPU device index is out of range";
                return false;
            }
            cuda_err = cudaSetDevice(selected_device);
            if (cuda_err != cudaSuccess) {
                error = std::string("cudaSetDevice failed for native FEM backend: ") +
                        cudaGetErrorString(cuda_err);
                return false;
            }
            std::call_once(s_mfem_device_once, [&, device_config]() {
                ctx.mfem_device = new mfem::Device(device_config);
            });
            ctx.mfem_selected_device_index = selected_device;

            // S12: Create prioritized CUDA streams
            int low_priority = 0, high_priority = 0;
            cudaDeviceGetStreamPriorityRange(&low_priority, &high_priority);
            cudaStream_t cs{}, ios{};
            cudaStreamCreateWithPriority(&cs, cudaStreamNonBlocking, high_priority);
            cudaStreamCreateWithPriority(&ios, cudaStreamNonBlocking, low_priority);
            ctx.compute_stream = reinterpret_cast<void *>(cs);
            ctx.io_stream = reinterpret_cast<void *>(ios);
            cudaEvent_t ev{};
            cudaEventCreateWithFlags(&ev, cudaEventDisableTiming);
            ctx.compute_event = reinterpret_cast<void *>(ev);
        } else {
            configure_cpu_openmp_runtime(ctx);
            // Phase-0B fix: pass the original host device string (e.g. "omp",
            // "ceed-cpu") to MFEM instead of hard-coding "cpu".
            const char *host_device = (device_config != nullptr && *device_config != '\0')
                ? device_config : "cpu";
            std::call_once(s_mfem_device_once, [&ctx, host_device]() {
                ctx.mfem_device = new mfem::Device(host_device);
            });
            ctx.mfem_selected_device_index = -1;
            log_cpu_runtime_selection(ctx);
        }
#else
        configure_cpu_openmp_runtime(ctx);
        std::call_once(s_mfem_device_once, [&ctx]() {
            ctx.mfem_device = new mfem::Device("cpu");
        });
        ctx.mfem_selected_device_index = -1;
        log_cpu_runtime_selection(ctx);
#endif

        debug_checkpoint("context_initialize_mfem:device_ready");
        auto *mesh = new mfem::Mesh(3, static_cast<int>(ctx.n_nodes), static_cast<int>(ctx.n_elements),
                                    static_cast<int>(ctx.n_boundary_faces), 3);

        for (uint32_t i = 0; i < ctx.n_nodes; ++i) {
            const double *coords = ctx.nodes_xyz.data() + static_cast<size_t>(i) * 3u;
            mesh->AddVertex(coords);
        }

        for (uint32_t i = 0; i < ctx.n_elements; ++i) {
            const int *ignored = nullptr;
            (void)ignored;
            const uint32_t *tet = ctx.elements.data() + static_cast<size_t>(i) * 4u;
            const int vi[4] = {
                static_cast<int>(tet[0]),
                static_cast<int>(tet[1]),
                static_cast<int>(tet[2]),
                static_cast<int>(tet[3]),
            };
            // MFEM attributes must be >= 1.  Our markers: 1 = magnetic, 0 = air.
            // Map: marker 0 -> attr 2 (air), marker 1 -> attr 1 (magnetic).
            // Any other marker m -> attr m (unchanged, already >= 1).
            int attr = 1;
            if (!ctx.element_markers.empty()) {
                const uint32_t marker = ctx.element_markers[static_cast<size_t>(i)];
                attr = marker == 0u ? 2 : static_cast<int>(marker);
            }
            mesh->AddTet(vi, attr);
        }

        for (uint32_t i = 0; i < ctx.n_boundary_faces; ++i) {
            const uint32_t *tri = ctx.boundary_faces.data() + static_cast<size_t>(i) * 3u;
            const int vi[3] = {
                static_cast<int>(tri[0]),
                static_cast<int>(tri[1]),
                static_cast<int>(tri[2]),
            };
            const int attr = ctx.boundary_markers.empty()
                ? 1
                : static_cast<int>(ctx.boundary_markers[static_cast<size_t>(i)]);
            mesh->AddBdrTriangle(vi, attr);
        }

        mesh->FinalizeTopology();
        mesh->Finalize(false, true);
        debug_checkpoint("context_initialize_mfem:mesh_ready");

        auto *fec = new mfem::H1_FECollection(static_cast<int>(ctx.fe_order), mesh->Dimension());
        auto *fes = new mfem::FiniteElementSpace(mesh, fec);
        debug_checkpoint("context_initialize_mfem:fes_ready");

        if (fes->GetNDofs() != static_cast<int>(ctx.n_nodes)) {
            error = "MFEM H1 P1 space DOF count does not match node count";
            delete fes;
            delete fec;
            delete mesh;
            return false;
        }

        unpack_aos_to_components(ctx.m_xyz, ctx.mfem_mx, ctx.mfem_my, ctx.mfem_mz);
        auto *gf_mx = new mfem::GridFunction(fes);
        auto *gf_my = new mfem::GridFunction(fes);
        auto *gf_mz = new mfem::GridFunction(fes);
        auto *gf_a = new mfem::GridFunction(fes);
        auto *gf_ms = new mfem::GridFunction(fes);
        auto *a_coeff = new mfem::GridFunctionCoefficient(gf_a);
        // S09: enable device memory so that future GPU operators find data
        // already on device without extra H2D copies.
        gf_mx->UseDevice(true);
        gf_my->UseDevice(true);
        gf_mz->UseDevice(true);
        gf_a->UseDevice(true);
        gf_ms->UseDevice(true);
        double *mx_host = audited_host_write(*gf_mx);
        double *my_host = audited_host_write(*gf_my);
        double *mz_host = audited_host_write(*gf_mz);
        double *a_host = audited_host_write(*gf_a);
        double *ms_host = audited_host_write(*gf_ms);
        for (int i = 0; i < fes->GetNDofs(); ++i) {
            mx_host[i] = ctx.mfem_mx[static_cast<size_t>(i)];
            my_host[i] = ctx.mfem_my[static_cast<size_t>(i)];
            mz_host[i] = ctx.mfem_mz[static_cast<size_t>(i)];
            a_host[i] = scalar_field_value(
                ctx.A_field,
                static_cast<size_t>(i),
                ctx.material.exchange_stiffness);
            ms_host[i] = scalar_field_value(
                ctx.Ms_field,
                static_cast<size_t>(i),
                ctx.material.saturation_magnetisation);
        }

        if (!initialize_exchange_operator_mfem(ctx, *mesh, *fes, *a_coeff, error)) {
            delete a_coeff;
            delete gf_ms;
            delete gf_a;
            delete gf_mx;
            delete gf_my;
            delete gf_mz;
            delete fes;
            delete fec;
            delete mesh;
            return false;
        }
        debug_checkpoint("context_initialize_mfem:exchange_operator_ready");
        ctx.mfem_mesh = mesh;
        ctx.mfem_fec = fec;
        ctx.mfem_fes = fes;
        ctx.mfem_gf_mx = gf_mx;
        ctx.mfem_gf_my = gf_my;
        ctx.mfem_gf_mz = gf_mz;
        ctx.mfem_gf_a = gf_a;
        ctx.mfem_gf_ms = gf_ms;
        ctx.mfem_a_coeff = a_coeff;
        ctx.mfem_ready = true;
        debug_checkpoint("context_initialize_mfem:done");
        return true;
    } catch (const std::exception &ex) {
        error = std::string("MFEM mesh/space initialization failed: ") + ex.what();
    } catch (...) {
        error = "MFEM mesh/space initialization failed with an unknown error";
    }

    context_destroy_mfem(ctx);
    return false;
}

bool context_upload_mfem_exchange_to_gpu_state(Context &ctx, std::string &error)
{
    if (!ctx.mfem_ready) {
        error = "legacy sparse exchange GPU upload requested before MFEM context initialization";
        return false;
    }
    auto *exchange_form = static_cast<mfem::BilinearForm *>(ctx.mfem_exchange_form);
    if (exchange_form == nullptr) {
        error = "legacy sparse exchange GPU upload requested without MFEM exchange form";
        return false;
    }
    if (!upload_legacy_sparse_exchange_to_gpu_state(
            ctx,
            exchange_form->SpMat(),
            error)) {
        error = "legacy sparse exchange GPU upload failed: " + error;
        return false;
    }
    return true;
}

void context_destroy_mfem(Context &ctx) {
    // Destroy demag resources first.
    context_destroy_demag_fem_bem(ctx);
    context_destroy_poisson(ctx);

    destroy_dmi_workspace(ctx);

    // NOTE: mfem::Device is a process-global singleton — do NOT delete it here,
    // because a subsequent NativeFemBackend may need the already-configured device.
    delete static_cast<mfem::Coefficient *>(ctx.mfem_a_coeff);
    delete static_cast<mfem::Vector *>(ctx.mfem_exchange_out_vec);
    delete static_cast<mfem::Vector *>(ctx.mfem_exchange_tmp_vec);
    delete static_cast<mfem::Vector *>(ctx.mfem_inv_lumped_mass);
    delete static_cast<mfem::Vector *>(ctx.mfem_mass_lumped);
    delete static_cast<mfem::Vector *>(ctx.mfem_mass_ones);
    delete static_cast<mfem::BilinearForm *>(ctx.mfem_mass_form);
    delete static_cast<mfem::BilinearForm *>(ctx.mfem_exchange_form);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_gf_ms);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_gf_a);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_gf_mz);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_gf_my);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_gf_mx);
    delete static_cast<mfem::FiniteElementSpace *>(ctx.mfem_fes);
    delete static_cast<mfem::FiniteElementCollection *>(ctx.mfem_fec);
    delete static_cast<mfem::Mesh *>(ctx.mfem_mesh);
    ctx.mfem_device = nullptr;
    ctx.mfem_mass_form = nullptr;
    ctx.mfem_exchange_form = nullptr;
    ctx.mfem_a_coeff = nullptr;
    ctx.mfem_exchange_out_vec = nullptr;
    ctx.mfem_exchange_tmp_vec = nullptr;
    ctx.mfem_inv_lumped_mass = nullptr;
    ctx.mfem_mass_lumped = nullptr;
    ctx.mfem_mass_ones = nullptr;
    ctx.mfem_gf_ms = nullptr;
    ctx.mfem_gf_a = nullptr;
    ctx.mfem_gf_mz = nullptr;
    ctx.mfem_gf_my = nullptr;
    ctx.mfem_gf_mx = nullptr;
    ctx.mfem_fes = nullptr;
    ctx.mfem_fec = nullptr;
    ctx.mfem_mesh = nullptr;
    ctx.mfem_ready = false;
    ctx.mfem_exchange_ready = false;
    ctx.gpu_exchange_legacy_sparse_metadata_ready = false;
    ctx.gpu_exchange_legacy_sparse_rows = 0;
    ctx.gpu_exchange_legacy_sparse_cols = 0;
    ctx.gpu_exchange_legacy_sparse_nnz = 0;
    ctx.gpu_exchange_lumped_mass_ready = false;

    // S12: Destroy CUDA streams and events
#if FULLMAG_HAS_CUDA_RUNTIME
    if (ctx.compute_stream != nullptr) {
        cudaStreamDestroy(reinterpret_cast<cudaStream_t>(ctx.compute_stream));
        ctx.compute_stream = nullptr;
    }
    if (ctx.io_stream != nullptr) {
        cudaStreamDestroy(reinterpret_cast<cudaStream_t>(ctx.io_stream));
        ctx.io_stream = nullptr;
    }
    if (ctx.compute_event != nullptr) {
        cudaEventDestroy(reinterpret_cast<cudaEvent_t>(ctx.compute_event));
        ctx.compute_event = nullptr;
    }
    // S13: Free pinned snapshot buffers
    for (auto &buf : ctx.pinned_snapshot) {
        if (buf != nullptr) {
            cudaFreeHost(buf);
            buf = nullptr;
        }
    }
    ctx.pinned_snapshot_bytes = 0;
#endif
}

bool context_snapshot_stats_mfem(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &error)
{
    const auto wall_start = SteadyClock::now();
    PhaseTimings timings;
    stats = {};
    ctx.demag_solves_current_step = 0;

    if (!ctx.mfem_ready) {
        error = "MFEM snapshot requested before MFEM context initialization";
        return false;
    }
    // FND-005 fix: accept any effective-field term, not just exchange/demag.
    if (!has_any_field_or_direct_torque_term(ctx)) {
        error = "native FEM snapshot requires at least one effective-field term";
        return false;
    }
    if (!context_sync_gpu_magnetization_to_host(ctx, error)) {
        return false;
    }

    std::vector<double> h_ex_current;
    std::vector<double> h_demag_current;
    std::vector<double> h_eff_current;
    double exchange_energy = 0.0;
    double demag_energy = 0.0;
    if (!compute_effective_fields_for_magnetization(
            ctx,
            ctx.m_xyz,
            h_ex_current,
            h_demag_current,
            h_eff_current,
            &exchange_energy,
            &demag_energy,
            false,
            &timings,
            error)) {
        return false;
    }
    if (poll_interrupt(ctx)) {
        return true;
    }

    ctx.h_ex_xyz = std::move(h_ex_current);
    ctx.h_demag_xyz = std::move(h_demag_current);
    ctx.h_eff_xyz = std::move(h_eff_current);
    ctx.mfem_exchange_ready = true;

    std::vector<double> rhs_current;
    double max_rhs_current = 0.0;
    {
        ScopedPhaseTimer timer(&timings.rhs_wall_time_ns);
        llg_rhs_aos(
            ctx.m_xyz,
            ctx.h_eff_xyz,
            ctx.material.gyromagnetic_ratio,
            ctx.material.damping,
            ctx.alpha_field.empty() ? nullptr : &ctx.alpha_field,
            rhs_current,
            max_rhs_current);
        add_stt_rhs_aos(ctx, ctx.m_xyz, rhs_current, max_rhs_current);
        zero_non_magnetic_nodes_aos(rhs_current, ctx.magnetic_node_mask);
        max_rhs_current = max_norm_aos(rhs_current);
    }

    stats.step = ctx.step_count;
    stats.time_seconds = ctx.current_time;
    stats.dt_seconds = 0.0;
    stats.exchange_energy_joules = exchange_energy;
    stats.demag_energy_joules = demag_energy;
    fill_common_step_metrics(ctx, stats, max_rhs_current, &timings);
    timings.snapshot_wall_time_ns = elapsed_ns(wall_start);
    apply_phase_timings(stats, timings);
    stats.wall_time_ns = timings.snapshot_wall_time_ns;
    return true;
}

bool context_step_exchange_heun_mfem(
    Context &ctx,
    double dt_seconds,
    fullmag_fem_step_stats &stats,
    std::string &error)
{
    const auto wall_start = SteadyClock::now();
    PhaseTimings timings;
    stats = {};
    ctx.demag_solves_current_step = 0;

    if (!ctx.mfem_ready) {
        error = "MFEM step requested before MFEM context initialization";
        return false;
    }
    // FND-005 fix: accept any effective-field term, not just exchange/demag.
    if (!has_any_field_or_direct_torque_term(ctx)) {
        error = "native FEM stepper requires at least one effective-field term to be enabled";
        return false;
    }
    if (dt_seconds <= 0.0) {
        error = "native FEM GPU stepper requires a positive dt";
        return false;
    }
    ctx.current_dt = dt_seconds;

    std::vector<double> h_ex_now;
    std::vector<double> h_demag_now;
    std::vector<double> h_eff_now;
    double exchange_energy = 0.0;
    double demag_energy = 0.0;
    if (!compute_effective_fields_for_magnetization(
            ctx,
            ctx.m_xyz,
            h_ex_now,
            h_demag_now,
            h_eff_now,
            &exchange_energy,
            &demag_energy,
            true,
            &timings,
            error)) {
        if (ctx.step_interrupted) {
            return true;
        }
        return false;
    }

    std::vector<double> k1;
    double max_rhs_k1 = 0.0;
    {
        ScopedPhaseTimer timer(&timings.rhs_wall_time_ns);
        llg_rhs_aos(
            ctx.m_xyz,
            h_eff_now,
            ctx.material.gyromagnetic_ratio,
            ctx.material.damping,
            ctx.alpha_field.empty() ? nullptr : &ctx.alpha_field,
            k1,
            max_rhs_k1);
        add_stt_rhs_aos(ctx, ctx.m_xyz, k1, max_rhs_k1);
        zero_non_magnetic_nodes_aos(k1, ctx.magnetic_node_mask);
    }
    if (poll_interrupt(ctx)) {
        return true;
    }

    std::vector<double> predicted = ctx.m_xyz;
    for (size_t i = 0; i < predicted.size(); ++i) {
        predicted[i] += dt_seconds * k1[i];
    }
    normalize_aos_field(predicted);
    project_static_periodic_aos(ctx, predicted);

    std::vector<double> h_ex_pred;
    std::vector<double> h_demag_pred;
    std::vector<double> h_eff_pred;
    if (!compute_effective_fields_for_magnetization(
            ctx,
            predicted,
            h_ex_pred,
            h_demag_pred,
            h_eff_pred,
            nullptr,
            nullptr,
            true,
            &timings,
            error)) {
        if (ctx.step_interrupted) {
            return true;
        }
        return false;
    }
    if (poll_interrupt(ctx)) {
        return true;
    }

    std::vector<double> k2;
    double max_rhs_k2 = 0.0;
    {
        ScopedPhaseTimer timer(&timings.rhs_wall_time_ns);
        llg_rhs_aos(
            predicted,
            h_eff_pred,
            ctx.material.gyromagnetic_ratio,
            ctx.material.damping,
            ctx.alpha_field.empty() ? nullptr : &ctx.alpha_field,
            k2,
            max_rhs_k2);
        add_stt_rhs_aos(ctx, predicted, k2, max_rhs_k2);
        zero_non_magnetic_nodes_aos(k2, ctx.magnetic_node_mask);
    }
    if (poll_interrupt(ctx)) {
        return true;
    }

    std::vector<double> corrected = ctx.m_xyz;
    for (size_t i = 0; i < corrected.size(); ++i) {
        corrected[i] += 0.5 * dt_seconds * (k1[i] + k2[i]);
    }
    normalize_aos_field(corrected);
    project_static_periodic_aos(ctx, corrected);

    std::vector<double> h_ex_final;
    std::vector<double> h_demag_final;
    std::vector<double> h_eff_final;
    double exchange_energy_final = 0.0;
    double demag_energy_final = 0.0;
    if (!compute_effective_fields_for_magnetization(
            ctx,
            corrected,
            h_ex_final,
            h_demag_final,
            h_eff_final,
            &exchange_energy_final,
            &demag_energy_final,
            true,
            &timings,
            error)) {
        if (ctx.step_interrupted) {
            return true;
        }
        return false;
    }
    if (poll_interrupt(ctx)) {
        return true;
    }

    ctx.m_xyz = std::move(corrected);
    ctx.h_ex_xyz = std::move(h_ex_final);
    ctx.h_demag_xyz = std::move(h_demag_final);
    ctx.h_eff_xyz = std::move(h_eff_final);
    ctx.current_time += dt_seconds;
    ctx.step_count += 1;
    ctx.mfem_exchange_ready = true;

    // Compute post-step RHS from final corrected state (matches CPU metric).
    std::vector<double> rhs_final;
    double max_rhs_final = 0.0;
    {
        ScopedPhaseTimer timer(&timings.rhs_wall_time_ns);
        llg_rhs_aos(
            ctx.m_xyz,
            ctx.h_eff_xyz,
            ctx.material.gyromagnetic_ratio,
            ctx.material.damping,
            ctx.alpha_field.empty() ? nullptr : &ctx.alpha_field,
            rhs_final,
            max_rhs_final);
        add_stt_rhs_aos(ctx, ctx.m_xyz, rhs_final, max_rhs_final);
        zero_non_magnetic_nodes_aos(rhs_final, ctx.magnetic_node_mask);
        max_rhs_final = max_norm_aos(rhs_final);
    }

    stats.step = ctx.step_count;
    stats.time_seconds = ctx.current_time;
    stats.dt_seconds = dt_seconds;
    stats.exchange_energy_joules = exchange_energy_final;
    stats.demag_energy_joules = demag_energy_final;
    fill_common_step_metrics(ctx, stats, max_rhs_final, &timings);
    stats.error_estimate = 0.0;
    stats.rejected_attempts = 0;
    stats.dt_suggested = 0.0;
    stats.rhs_evaluations = 2;
    stats.fsal_reused = 0;
    apply_phase_timings(stats, timings);
    stats.wall_time_ns = elapsed_ns(wall_start);
    update_stage_completion_from_stats(ctx, stats);

    return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Unified explicit Runge-Kutta engine (Butcher tableau-driven)
// ═══════════════════════════════════════════════════════════════════════════

bool context_step_explicit_rk_mfem(
    Context &ctx,
    const ExplicitTableau &tab,
    double dt_seconds,
    fullmag_fem_step_stats &stats,
    std::string &error)
{
    const auto wall_start = SteadyClock::now();
    PhaseTimings timings;
    stats = {};
    ctx.demag_solves_current_step = 0;

    if (!ctx.mfem_ready) {
        error = "MFEM step requested before MFEM context initialization";
        return false;
    }
    // FND-005 fix: accept any effective-field term, not just exchange/demag.
    if (!has_any_field_or_direct_torque_term(ctx)) {
        error = "native FEM stepper requires at least one effective-field term";
        return false;
    }
    if (dt_seconds <= 0.0) {
        error = "native FEM GPU stepper requires a positive dt";
        return false;
    }

    if ((ctx.integrator == FULLMAG_FEM_INTEGRATOR_HEUN && tab.stages == 2) ||
        (ctx.integrator == FULLMAG_FEM_INTEGRATOR_RK4 && tab.stages == 4) ||
        (ctx.integrator == FULLMAG_FEM_INTEGRATOR_RK23_BS && tab.stages == 4) ||
        (ctx.integrator == FULLMAG_FEM_INTEGRATOR_RK45_DP54 && tab.stages == 7)) {
        std::string gpu_rk_reason;
        const auto gpu_rk_plan = gpu_rk_plan_exchange_only(ctx, gpu_rk_reason);
        if (gpu_rk_plan.enabled) {
            if (!gpu_rk_exchange_only_step(ctx, tab, dt_seconds, stats, gpu_rk_reason)) {
                error = gpu_rk_reason;
                return false;
            }
            stats.wall_time_ns = elapsed_ns(wall_start);
            return true;
        }
    }

    ctx.current_dt = dt_seconds;

    const size_t dof_len = ctx.m_xyz.size();
    stepper_workspace_allocate(ctx.stepper, dof_len, tab.stages);
    auto &ws = ctx.stepper;

    const bool adaptive = (tab.order_est > 0) && ctx.adaptive_dt_enabled;
    double dt = dt_seconds;
    uint32_t rejected = 0;
    uint32_t total_rhs = 0;
    bool fsal_used = false;
    bool final_stage_cache_valid = false;
    double exchange_energy_final = 0.0;
    double demag_energy_final = 0.0;

    // Outer accept/reject loop (runs once for non-adaptive)
    for (;;) {
        ctx.current_dt = dt;
        // Save m_backup
        ws.m_backup = ctx.m_xyz;
        final_stage_cache_valid = false;

        // Stage 0: evaluate or reuse FSAL
        if (tab.fsal && ws.fsal_valid) {
            // k[0] already holds the RHS from previous accepted step
            fsal_used = true;
        } else {
            double exchange_energy_s0 = 0.0;
            double demag_energy_s0 = 0.0;
            if (!evaluate_rk_stage_rhs(
                    ctx,
                    ctx.m_xyz,
                    ws,
                    ws.k[0],
                    nullptr,
                    &exchange_energy_s0,
                    &demag_energy_s0,
                    &timings,
                    error)) {
                if (ctx.step_interrupted) {
                    ctx.m_xyz = ws.m_backup;
                    ws.fsal_valid = false;
                    return true;
                }
                return false;
            }
            total_rhs += 1;
        }
        if (poll_interrupt(ctx)) {
            ctx.m_xyz = ws.m_backup;
            ws.fsal_valid = false;
            return true;
        }

        // Stages 1..s-1
        for (int s = 1; s < tab.stages; ++s) {
            // m_stage = m_backup + dt * sum_j(a[s][j] * k[j])
            for (size_t i = 0; i < dof_len; ++i) {
                double accum = 0.0;
                for (int j = 0; j < s; ++j) {
                    accum += tab.a[s][j] * ws.k[j][i];
                }
                ws.m_stage[i] = ws.m_backup[i] + dt * accum;
            }
            normalize_aos_field(ws.m_stage);
            project_static_periodic_aos(ctx, ws.m_stage);

            double *stage_exchange_energy = nullptr;
            double *stage_demag_energy = nullptr;
            if (tab.fsal && s == tab.stages - 1) {
                stage_exchange_energy = &exchange_energy_final;
                stage_demag_energy = &demag_energy_final;
            }
            if (!evaluate_rk_stage_rhs(ctx, ws.m_stage, ws, ws.k[s],
                                       nullptr,
                                       stage_exchange_energy,
                                       stage_demag_energy,
                                       &timings,
                                       error)) {
                if (ctx.step_interrupted) {
                    ctx.m_xyz = ws.m_backup;
                    ws.fsal_valid = false;
                    return true;
                }
                return false;
            }
            if (poll_interrupt(ctx)) {
                ctx.m_xyz = ws.m_backup;
                ws.fsal_valid = false;
                return true;
            }
            if (tab.fsal && s == tab.stages - 1) {
                final_stage_cache_valid = true;
            }
            total_rhs += 1;
        }

        // High-order solution: m_new = m_backup + dt * sum(b_hi[s] * k[s])
        for (size_t i = 0; i < dof_len; ++i) {
            double accum = 0.0;
            for (int s = 0; s < tab.stages; ++s) {
                accum += tab.b_hi[s] * ws.k[s][i];
            }
            ctx.m_xyz[i] = ws.m_backup[i] + dt * accum;
        }
        normalize_aos_field(ctx.m_xyz);
        project_static_periodic_aos(ctx, ctx.m_xyz);
        if (poll_interrupt(ctx)) {
            ctx.m_xyz = ws.m_backup;
            ws.fsal_valid = false;
            return true;
        }

        // For adaptive methods, compute error estimate
        if (adaptive) {
            for (size_t i = 0; i < dof_len; ++i) {
                double err_accum = 0.0;
                for (int s = 0; s < tab.stages; ++s) {
                    err_accum += (tab.b_hi[s] - tab.b_lo[s]) * ws.k[s][i];
                }
                ws.err[i] = dt * err_accum;
            }
            double err_norm = compute_adaptive_error_norm(
                ws.err,
                ws.m_backup,
                ctx.m_xyz,
                ctx.adaptive_atol,
                ctx.adaptive_rtol);
            auto result = adaptive_pi_step(ctx, err_norm);
            if (!result.accepted) {
                // Reject: restore, shrink dt, retry
                ctx.m_xyz = ws.m_backup;
                dt = result.dt_next;
                ctx.dt_seconds = dt;
                ctx.current_dt = dt;
                ws.fsal_valid = false;
                rejected += 1;
                if (rejected > ctx.max_reject) {
                    error = "adaptive RK exceeded adaptive_config.max_reject rejected attempts before accepting a step";
                    return false;
                }
                continue;
            }
            if (poll_interrupt(ctx)) {
                ctx.m_xyz = ws.m_backup;
                ws.fsal_valid = false;
                return true;
            }
            stats.error_estimate = err_norm;
            stats.dt_suggested = result.dt_next;
            ctx.dt_seconds = result.dt_next;
        } else {
            stats.error_estimate = 0.0;
            stats.dt_suggested = dt;
        }

        // Accept: FSAL cache for next step
        if (tab.fsal) {
            // Last stage k[stages-1] evaluated at c=1 becomes k[0] of next step
            std::swap(ws.k[0], ws.k[tab.stages - 1]);
            ws.fsal_valid = true;
        } else {
            ws.fsal_valid = false;
        }

        break; // accepted
    }

    if (final_stage_cache_valid) {
        // FSAL tableaux used here evaluate the last stage at c=1 using the same
        // state as the accepted high-order solution, so we can reuse the cached
        // H_ex/H_demag/H_eff and avoid a full post-step recompute.
        std::swap(ctx.h_ex_xyz, ws.h_ex_tmp);
        std::swap(ctx.h_demag_xyz, ws.h_demag_tmp);
        std::swap(ctx.h_eff_xyz, ws.h_eff_tmp);
    } else {
        if (!compute_effective_fields_for_magnetization(
                ctx,
                ctx.m_xyz,
                ws.h_ex_tmp,
                ws.h_demag_tmp,
                ws.h_eff_tmp,
                &exchange_energy_final,
                &demag_energy_final,
                true,
                &timings,
                error)) {
            if (ctx.step_interrupted) {
                ctx.m_xyz = ws.m_backup;
                ws.fsal_valid = false;
                return true;
            }
            return false;
        }
        std::swap(ctx.h_ex_xyz, ws.h_ex_tmp);
        std::swap(ctx.h_demag_xyz, ws.h_demag_tmp);
        std::swap(ctx.h_eff_xyz, ws.h_eff_tmp);
    }
    ctx.current_time += dt;
    ctx.step_count += 1;
    ctx.mfem_exchange_ready = true;

    // Post-step RHS for max_dm_dt metric
    double max_rhs_final = 0.0;
    if (final_stage_cache_valid) {
        max_rhs_final = max_norm_aos(ws.k[0]);
    } else {
        ScopedPhaseTimer timer(&timings.rhs_wall_time_ns);
        llg_rhs_aos(ctx.m_xyz, ctx.h_eff_xyz,
                    ctx.material.gyromagnetic_ratio, ctx.material.damping,
                    ctx.alpha_field.empty() ? nullptr : &ctx.alpha_field,
                    ws.k[0], max_rhs_final);
        add_stt_rhs_aos(ctx, ctx.m_xyz, ws.k[0], max_rhs_final);
        zero_non_magnetic_nodes_aos(ws.k[0], ctx.magnetic_node_mask);
        max_rhs_final = max_norm_aos(ws.k[0]);
        total_rhs += 1;
    }

    stats.step = ctx.step_count;
    stats.time_seconds = ctx.current_time;
    stats.dt_seconds = dt;
    stats.exchange_energy_joules = exchange_energy_final;
    stats.demag_energy_joules = demag_energy_final;
    fill_common_step_metrics(ctx, stats, max_rhs_final, &timings);
    stats.rejected_attempts = rejected;
    stats.rhs_evaluations = total_rhs;
    stats.fsal_reused = fsal_used ? 1 : 0;
    apply_phase_timings(stats, timings);
    stats.wall_time_ns = elapsed_ns(wall_start);
    update_stage_completion_from_stats(ctx, stats);

    return true;
}

} // namespace fullmag::fem

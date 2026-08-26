/*
 * MFEM context runtime source contract.
 *
 * This source owns native MFEM resource lifecycle, mesh/space/operator
 * initialization, teardown, and compatibility upload wrappers for the Context
 * facade. It does not own device selection, GPU-state bootstrap, interaction physics, or step integrators.
 */

#include "cpu/mfem/runtime/mfem_context.hpp"

#include "context.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include "cpu/mfem/interactions/demag_fem_bem.hpp"
#include "cpu/mfem/interactions/demag_poisson.hpp"
#include "cpu/mfem/interactions/demag_poisson_lifecycle.hpp"
#include "cpu/mfem/interactions/dmi.hpp"
#include "cpu/mfem/interactions/exchange.hpp"
#include "cpu/mfem/relaxation/relaxation_math.hpp"
#include "cpu/mfem/runtime/aos_field.hpp"
#include "cpu/mfem/runtime/cpu_threads.hpp"
#include "cpu/mfem/runtime/mfem_device.hpp"
#include "cpu/mfem/runtime/mfem_host_access.hpp"
#include "cpu/mfem/runtime/mfem_mesh_builder.hpp"
#include "fem_common.hpp"
#include "gpu/cuda/transfer/snapshot_pool.hpp"

#include <mfem.hpp>

#include <cstdio>
#include <cstdlib>
#include <memory>
#include <optional>
#include <algorithm>
#include <stdexcept>
#include <string>
#include <vector>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
namespace {

std::optional<int> selected_cuda_device_from_env()
{
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

void debug_checkpoint(const char *stage)
{
    static const bool enabled = debug_startup_env_enabled();
    if (!enabled) {
        return;
    }
    std::fprintf(stderr, "[fullmag_fem][debug] %s\n", stage);
    std::fflush(stderr);
}

enum class AdapterCoefficientKind {
    saturation_magnetisation,
    exchange_stiffness,
};

class AdapterBackedElementwiseCoefficient final : public mfem::Coefficient {
public:
    AdapterBackedElementwiseCoefficient(
        const FemMaterialRuntimeAdapter &runtime,
        AdapterCoefficientKind kind)
        : runtime_(runtime), kind_(kind)
    {
    }

    double Eval(mfem::ElementTransformation &T, const mfem::IntegrationPoint &) override
    {
        const int element = T.ElementNo;
        if (element < 0) {
            throw std::out_of_range("MFEM element ordinal is negative");
        }
        const std::size_t ordinal = static_cast<std::size_t>(element);
        const auto &realization = runtime_.realization();
        if (ordinal >= realization.element_count()) {
            throw std::out_of_range("MFEM element ordinal exceeds material realization");
        }
        const auto &active = realization.active_element_ordinals();
        if (std::find(active.begin(), active.end(), ordinal) == active.end()) {
            return 0.0;
        }
        return kind_ == AdapterCoefficientKind::exchange_stiffness
            ? realization.a_j_per_m(ordinal)
            : realization.ms_a_per_m(ordinal);
    }

private:
    const FemMaterialRuntimeAdapter &runtime_;
    AdapterCoefficientKind kind_;
};

#if FULLMAG_HAS_CUDA_RUNTIME
static const char *resolve_global_device_config(const Context &ctx)
{
    const char *device_config = configured_mfem_device_string(ctx);
    if (is_gpu_device_string(device_config)) {
        return device_config;
    }
    // If the context explicitly requested a non-GPU device (e.g. "cpu"),
    // respect that intent — do not auto-promote to CUDA.
    if (device_config != nullptr && device_config[0] != '\0') {
        return device_config;
    }
    const char *env_device = std::getenv("FULLMAG_FEM_MFEM_DEVICE");
    if (env_device != nullptr && env_device[0] != '\0' && is_gpu_device_string(env_device)) {
        return env_device;
    }
    int device_count = 0;
    if (cudaGetDeviceCount(&device_count) == cudaSuccess && device_count > 0) {
        return "cuda";
    }
    return "cpu";
}
#endif

static mfem::Device *global_device = nullptr;

static void cleanup_global_device()
{
    delete global_device;
    global_device = nullptr;
}

class MfemInitializationRollback {
public:
    explicit MfemInitializationRollback(Context &ctx) : ctx_(ctx) {}

    ~MfemInitializationRollback()
    {
        if (active_) {
            context_destroy_mfem(ctx_);
        }
    }

    void commit() noexcept { active_ = false; }

private:
    Context &ctx_;
    bool active_ = true;
};

} // namespace

bool context_initialize_mfem(Context &ctx, std::string &error)
{
    try {
        debug_checkpoint("context_initialize_mfem:enter");
        std::unique_ptr<mfem::Mesh> mesh_owner;
        if (!build_mfem_mesh(ctx.mesh, mesh_owner, error)) {
            return false;
        }
        auto *mesh = mesh_owner.get();
        debug_checkpoint("context_initialize_mfem:mesh_ready");

        MfemInitializationRollback rollback(ctx);
        configure_fem_host_runtime_threads(ctx);
#if FULLMAG_HAS_CUDA_RUNTIME
        const char *device_config = configured_mfem_device_string(ctx);
        const bool use_gpu_device = is_gpu_device_string(device_config);

        const char *global_config = resolve_global_device_config(ctx);
        const bool global_use_gpu = is_gpu_device_string(global_config);

        if (global_use_gpu) {
            const int selected_device = (ctx.mfem_device.gpu_device_index >= 0)
                ? ctx.mfem_device.gpu_device_index
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

            if (mfem::Device::IsConfigured()) {
                ctx.mfem_context.device = nullptr;
            } else {
                global_device = new mfem::Device(global_config);
                ctx.mfem_context.device = global_device;
                std::atexit(cleanup_global_device);
            }

            if (use_gpu_device) {
                ctx.mfem_context.selected_device_index = selected_device;
                int low_priority = 0;
                int high_priority = 0;
                cuda_err = cudaDeviceGetStreamPriorityRange(&low_priority, &high_priority);
                if (cuda_err != cudaSuccess) {
                    error = std::string("cudaDeviceGetStreamPriorityRange failed for native FEM backend: ") +
                            cudaGetErrorString(cuda_err);
                    return false;
                }
                cudaStream_t cs{};
                cudaStream_t ios{};
                cuda_err = cudaStreamCreateWithPriority(&cs, cudaStreamNonBlocking, high_priority);
                if (cuda_err != cudaSuccess) {
                    error = std::string("CUDA compute-stream creation failed for native FEM backend: ") +
                            cudaGetErrorString(cuda_err);
                    return false;
                }
                ctx.gpu_state.cuda.compute_stream = reinterpret_cast<void *>(cs);
                cuda_err = cudaStreamCreateWithPriority(&ios, cudaStreamNonBlocking, low_priority);
                if (cuda_err != cudaSuccess) {
                    error = std::string("CUDA I/O-stream creation failed for native FEM backend: ") +
                            cudaGetErrorString(cuda_err);
                    return false;
                }
                ctx.gpu_state.cuda.io_stream = reinterpret_cast<void *>(ios);
                cudaEvent_t ev{};
                cuda_err = cudaEventCreateWithFlags(&ev, cudaEventDisableTiming);
                if (cuda_err != cudaSuccess) {
                    error = std::string("CUDA compute-event creation failed for native FEM backend: ") +
                            cudaGetErrorString(cuda_err);
                    return false;
                }
                ctx.gpu_state.cuda.compute_event = reinterpret_cast<void *>(ev);
            } else {
                ctx.mfem_context.selected_device_index = -1;
                log_cpu_runtime_selection(ctx);
            }
        } else {
            const char *host_device = (device_config != nullptr && *device_config != '\0')
                ? device_config : "cpu";
            if (mfem::Device::IsConfigured()) {
                ctx.mfem_context.device = nullptr;
            } else {
                global_device = new mfem::Device(host_device);
                ctx.mfem_context.device = global_device;
                std::atexit(cleanup_global_device);
            }
            ctx.mfem_context.selected_device_index = -1;
            log_cpu_runtime_selection(ctx);
        }
#else
        const bool use_gpu_device = false;
        if (mfem::Device::IsConfigured()) {
            ctx.mfem_context.device = nullptr;
        } else {
            global_device = new mfem::Device("cpu");
            ctx.mfem_context.device = global_device;
            std::atexit(cleanup_global_device);
        }
        ctx.mfem_context.selected_device_index = -1;
        log_cpu_runtime_selection(ctx);
#endif

        debug_checkpoint("context_initialize_mfem:device_ready");
        auto fec = std::make_unique<mfem::H1_FECollection>(
            static_cast<int>(ctx.base_plan.fe_order), mesh->Dimension());
        auto fes = std::make_unique<mfem::FiniteElementSpace>(mesh, fec.get());
        debug_checkpoint("context_initialize_mfem:fes_ready");

        if (fes->GetNDofs() != static_cast<int>(ctx.mesh.n_nodes)) {
            error = "MFEM H1 P1 space DOF count does not match node count";
            return false;
        }

        unpack_aos_to_components(ctx.state.m_xyz, ctx.mfem_context.m_x, ctx.mfem_context.m_y, ctx.mfem_context.m_z);
        auto gf_mx = std::make_unique<mfem::GridFunction>(fes.get());
        auto gf_my = std::make_unique<mfem::GridFunction>(fes.get());
        auto gf_mz = std::make_unique<mfem::GridFunction>(fes.get());
        auto gf_a = std::make_unique<mfem::GridFunction>(fes.get());
        auto gf_ms = std::make_unique<mfem::GridFunction>(fes.get());
        gf_mx->UseDevice(mfem::Device::IsEnabled());
        gf_my->UseDevice(mfem::Device::IsEnabled());
        gf_mz->UseDevice(mfem::Device::IsEnabled());
        gf_a->UseDevice(mfem::Device::IsEnabled());
        gf_ms->UseDevice(mfem::Device::IsEnabled());
        double *mx_host = audited_host_write(*gf_mx);
        double *my_host = audited_host_write(*gf_my);
        double *mz_host = audited_host_write(*gf_mz);
        double *a_host = audited_host_write(*gf_a);
        double *ms_host = audited_host_write(*gf_ms);
        for (int i = 0; i < fes->GetNDofs(); ++i) {
            mx_host[i] = ctx.mfem_context.m_x[static_cast<size_t>(i)];
            my_host[i] = ctx.mfem_context.m_y[static_cast<size_t>(i)];
            mz_host[i] = ctx.mfem_context.m_z[static_cast<size_t>(i)];
            a_host[i] = scalar_field_value(
                ctx.material_fields.A_field,
                static_cast<size_t>(i),
                ctx.material_fields.material.exchange_stiffness);
            ms_host[i] = scalar_field_value(
                ctx.material_fields.Ms_field,
                static_cast<size_t>(i),
                ctx.material_fields.material.saturation_magnetisation);
        }

        if (!ctx.material_fields.Ms_element_field.empty() &&
            !ctx.exchange.mfem.use_consistent_mass) {
            error = "per-element Ms coefficient requires consistent-mass exchange projection";
            return false;
        }

        const auto *runtime = ctx.material_fields.runtime
            ? &*ctx.material_fields.runtime
            : nullptr;
        const bool use_dg0_a = !ctx.material_fields.A_element_field.empty();
        const bool use_dg0_ms = !ctx.material_fields.Ms_element_field.empty();
        if ((use_dg0_a || use_dg0_ms) && runtime == nullptr) {
            error = "elementwise material coefficient requires initialized material runtime";
            return false;
        }
        if ((use_dg0_a && runtime->realization().a_location() != MaterialCoefficientLocation::element_dg0) ||
            (use_dg0_ms && runtime->realization().ms_location() != MaterialCoefficientLocation::element_dg0)) {
            error = "elementwise material payload does not match DG0 material realization";
            return false;
        }

        std::unique_ptr<mfem::Coefficient> a_coeff = use_dg0_a
            ? std::unique_ptr<mfem::Coefficient>(new AdapterBackedElementwiseCoefficient(
                  *runtime, AdapterCoefficientKind::exchange_stiffness))
            : std::unique_ptr<mfem::Coefficient>(new mfem::GridFunctionCoefficient(gf_a.get()));
        std::unique_ptr<mfem::Coefficient> ms_coeff = use_dg0_ms
            ? std::unique_ptr<mfem::Coefficient>(new AdapterBackedElementwiseCoefficient(
                  *runtime, AdapterCoefficientKind::saturation_magnetisation))
            : std::unique_ptr<mfem::Coefficient>(new mfem::GridFunctionCoefficient(gf_ms.get()));

        if (!initialize_exchange_operator_mfem(
                ctx, *mesh, *fes, *a_coeff, *ms_coeff, error)) {
            return false;
        }
        debug_checkpoint("context_initialize_mfem:exchange_operator_ready");
        ctx.mfem_context.mesh = mesh_owner.release();
        ctx.mfem_context.fec = fec.release();
        ctx.mfem_context.fes = fes.release();
        ctx.mfem_context.gf_mx = gf_mx.release();
        ctx.mfem_context.gf_my = gf_my.release();
        ctx.mfem_context.gf_mz = gf_mz.release();
        ctx.mfem_context.gf_a = gf_a.release();
        ctx.mfem_context.gf_ms = gf_ms.release();
        ctx.mfem_context.a_coeff = a_coeff.release();
        ctx.mfem_context.ms_coeff = ms_coeff.release();
        ctx.mfem_context.ready = true;
        rollback.commit();
        debug_checkpoint("context_initialize_mfem:done");
        return true;
    } catch (const std::exception &ex) {
        error = std::string("MFEM mesh/space initialization failed: ") + ex.what();
    } catch (...) {
        error = "MFEM mesh/space initialization failed with an unknown error";
    }

    return false;
}

bool context_upload_mfem_exchange_to_gpu_state(Context &ctx, std::string &error)
{
    if (!ctx.mfem_context.ready) {
        error = "legacy sparse exchange GPU upload requested before MFEM context initialization";
        return false;
    }
    auto *exchange_form = static_cast<mfem::BilinearForm *>(ctx.exchange.mfem.exchange_form);
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

void context_destroy_mfem(Context &ctx)
{
    relaxation::destroy_exchange_mass_preconditioner_cache(ctx);
    context_destroy_demag_fem_bem(ctx);
    context_destroy_poisson(ctx);
    destroy_dmi_workspace(ctx);

    delete static_cast<mfem::Coefficient *>(ctx.mfem_context.a_coeff);
    delete static_cast<mfem::Coefficient *>(ctx.mfem_context.ms_coeff);
    delete static_cast<mfem::Vector *>(ctx.exchange.mfem.out_vec);
    delete static_cast<mfem::Vector *>(ctx.exchange.mfem.tmp_vec);
    delete static_cast<mfem::Vector *>(ctx.exchange.mfem.inv_lumped_mass);
    delete static_cast<mfem::Vector *>(ctx.exchange.mfem.mass_lumped);
    delete static_cast<mfem::Vector *>(ctx.exchange.mfem.mass_ones);
    delete static_cast<mfem::CGSolver *>(ctx.exchange.mfem.consistent_mass_solver);
    delete static_cast<mfem::GSSmoother *>(ctx.exchange.mfem.consistent_mass_preconditioner);
    delete static_cast<mfem::SparseMatrix *>(ctx.exchange.mfem.consistent_mass_matrix);
    delete static_cast<mfem::Vector *>(ctx.exchange.mfem.periodic_mass_residual);
    delete static_cast<mfem::Vector *>(ctx.exchange.mfem.periodic_mass_solution);
    delete static_cast<mfem::Vector *>(ctx.exchange.mfem.periodic_mass_rhs);
    delete static_cast<mfem::CGSolver *>(ctx.exchange.mfem.periodic_mass_solver);
    delete static_cast<mfem::GSSmoother *>(ctx.exchange.mfem.periodic_mass_preconditioner);
    delete static_cast<mfem::SparseMatrix *>(ctx.exchange.mfem.periodic_mass_matrix);
    delete static_cast<mfem::BilinearForm *>(ctx.exchange.mfem.mass_form);
    delete static_cast<mfem::BilinearForm *>(ctx.exchange.mfem.exchange_form);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_context.gf_ms);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_context.gf_a);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_context.gf_mz);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_context.gf_my);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_context.gf_mx);
    delete static_cast<mfem::FiniteElementSpace *>(ctx.mfem_context.fes);
    delete static_cast<mfem::FiniteElementCollection *>(ctx.mfem_context.fec);
    delete static_cast<mfem::Mesh *>(ctx.mfem_context.mesh);
    // Preserve the process-global Device virtual singleton and clear only this
    // context's non-owning view so subsequent contexts retain the MFEM environment.
    ctx.mfem_context.device = nullptr;
    ctx.exchange.mfem.mass_form = nullptr;
    ctx.exchange.mfem.exchange_form = nullptr;
    ctx.mfem_context.a_coeff = nullptr;
    ctx.mfem_context.ms_coeff = nullptr;
    ctx.exchange.mfem.out_vec = nullptr;
    ctx.exchange.mfem.tmp_vec = nullptr;
    ctx.exchange.mfem.inv_lumped_mass = nullptr;
    ctx.exchange.mfem.mass_lumped = nullptr;
    ctx.exchange.mfem.mass_ones = nullptr;
    ctx.exchange.mfem.consistent_mass_preconditioner = nullptr;
    ctx.exchange.mfem.consistent_mass_solver = nullptr;
    ctx.exchange.mfem.consistent_mass_matrix = nullptr;
    ctx.exchange.mfem.periodic_mass_matrix = nullptr;
    ctx.exchange.mfem.periodic_mass_preconditioner = nullptr;
    ctx.exchange.mfem.periodic_mass_solver = nullptr;
    ctx.exchange.mfem.periodic_mass_rhs = nullptr;
    ctx.exchange.mfem.periodic_mass_solution = nullptr;
    ctx.exchange.mfem.periodic_mass_residual = nullptr;
    ctx.exchange.mfem.consistent_mass_solver_applies = 0;
    ctx.exchange.mfem.periodic_mass_solver_applies = 0;
    ctx.exchange.mfem.periodic_mass_setup_count = 0;
    ctx.mfem_context.gf_ms = nullptr;
    ctx.mfem_context.gf_a = nullptr;
    ctx.mfem_context.gf_mz = nullptr;
    ctx.mfem_context.gf_my = nullptr;
    ctx.mfem_context.gf_mx = nullptr;
    ctx.mfem_context.fes = nullptr;
    ctx.mfem_context.fec = nullptr;
    ctx.mfem_context.mesh = nullptr;
    ctx.mfem_context.selected_device_index = -1;
    ctx.mfem_context.ready = false;
    ctx.exchange.mfem.ready = false;
    ctx.gpu_state.legacy_exchange.legacy_sparse_metadata_ready = false;
    ctx.gpu_state.legacy_exchange.legacy_sparse_rows = 0;
    ctx.gpu_state.legacy_exchange.legacy_sparse_cols = 0;
    ctx.gpu_state.legacy_exchange.legacy_sparse_nnz = 0;
    ctx.gpu_state.legacy_exchange.lumped_mass_ready = false;

#if FULLMAG_HAS_CUDA_RUNTIME
    if (ctx.gpu_state.cuda.io_stream != nullptr) {
        cudaStreamSynchronize(reinterpret_cast<cudaStream_t>(ctx.gpu_state.cuda.io_stream));
    }
    ctx.gpu_state.cuda.snapshot_pool.reset();
    if (ctx.gpu_state.cuda.compute_stream != nullptr) {
        cudaStreamDestroy(reinterpret_cast<cudaStream_t>(ctx.gpu_state.cuda.compute_stream));
        ctx.gpu_state.cuda.compute_stream = nullptr;
    }
    if (ctx.gpu_state.cuda.io_stream != nullptr) {
        cudaStreamDestroy(reinterpret_cast<cudaStream_t>(ctx.gpu_state.cuda.io_stream));
        ctx.gpu_state.cuda.io_stream = nullptr;
    }
    if (ctx.gpu_state.cuda.compute_event != nullptr) {
        cudaEventDestroy(reinterpret_cast<cudaEvent_t>(ctx.gpu_state.cuda.compute_event));
        ctx.gpu_state.cuda.compute_event = nullptr;
    }
#endif
}
#endif

} // namespace fullmag::fem

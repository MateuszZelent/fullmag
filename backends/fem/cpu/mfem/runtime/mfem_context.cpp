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
#include "fem_common.hpp"
#include "gpu/cuda/transfer/snapshot_pool.hpp"

#include <mfem.hpp>

#include <array>
#include <cstdio>
#include <cstdlib>
#include <map>
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

struct MfemBoundaryTriangle {
    std::array<uint32_t, 3> nodes{};
    uint32_t marker = 1;
};

std::array<uint32_t, 3> sorted_face_key(std::array<uint32_t, 3> face)
{
    std::sort(face.begin(), face.end());
    return face;
}

std::vector<MfemBoundaryTriangle> exterior_mfem_boundary_triangles(const Context &ctx)
{
    struct FaceRecord {
        std::array<uint32_t, 3> oriented_nodes{};
        uint32_t adjacent_elements = 0;
    };

    std::map<std::array<uint32_t, 3>, FaceRecord> face_records;
    const auto add_tet_face = [&](std::array<uint32_t, 3> oriented_nodes) {
        auto &record = face_records[sorted_face_key(oriented_nodes)];
        record.oriented_nodes = oriented_nodes;
        record.adjacent_elements += 1u;
    };

    for (uint32_t i = 0; i < ctx.mesh.n_elements; ++i) {
        const uint32_t *tet = ctx.mesh.elements.data() + static_cast<size_t>(i) * 4u;
        add_tet_face({tet[0], tet[2], tet[1]});
        add_tet_face({tet[0], tet[1], tet[3]});
        add_tet_face({tet[0], tet[3], tet[2]});
        add_tet_face({tet[1], tet[2], tet[3]});
    }

    std::map<std::array<uint32_t, 3>, uint32_t> input_markers;
    for (uint32_t i = 0; i < ctx.mesh.n_boundary_faces; ++i) {
        const uint32_t *tri = ctx.mesh.boundary_faces.data() + static_cast<size_t>(i) * 3u;
        uint32_t marker = 1u;
        if (!ctx.mesh.boundary_markers.empty()) {
            marker = ctx.mesh.boundary_markers[static_cast<size_t>(i)];
            if (marker == 0u) {
                marker = 1u;
            }
        }
        input_markers.emplace(sorted_face_key({tri[0], tri[1], tri[2]}), marker);
    }

    std::vector<MfemBoundaryTriangle> result;
    result.reserve(ctx.mesh.n_boundary_faces);
    for (const auto &[key, record] : face_records) {
        if (record.adjacent_elements != 1u) {
            continue;
        }
        const auto marker = input_markers.find(key);
        result.push_back({
            record.oriented_nodes,
            marker == input_markers.end() ? 1u : marker->second,
        });
    }
    return result;
}

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

} // namespace

bool context_initialize_mfem(Context &ctx, std::string &error)
{
    try {
        debug_checkpoint("context_initialize_mfem:enter");
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
                cudaDeviceGetStreamPriorityRange(&low_priority, &high_priority);
                cudaStream_t cs{};
                cudaStream_t ios{};
                cudaStreamCreateWithPriority(&cs, cudaStreamNonBlocking, high_priority);
                cudaStreamCreateWithPriority(&ios, cudaStreamNonBlocking, low_priority);
                ctx.gpu_state.cuda.compute_stream = reinterpret_cast<void *>(cs);
                ctx.gpu_state.cuda.io_stream = reinterpret_cast<void *>(ios);
                cudaEvent_t ev{};
                cudaEventCreateWithFlags(&ev, cudaEventDisableTiming);
                ctx.gpu_state.cuda.compute_event = reinterpret_cast<void *>(ev);
            } else {
                configure_cpu_openmp_runtime(ctx);
                ctx.mfem_context.selected_device_index = -1;
                log_cpu_runtime_selection(ctx);
            }
        } else {
            configure_cpu_openmp_runtime(ctx);
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
        configure_cpu_openmp_runtime(ctx);
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
        const auto mfem_boundary_triangles = exterior_mfem_boundary_triangles(ctx);
        auto *mesh = new mfem::Mesh(3, static_cast<int>(ctx.mesh.n_nodes), static_cast<int>(ctx.mesh.n_elements),
                                    static_cast<int>(mfem_boundary_triangles.size()), 3);

        for (uint32_t i = 0; i < ctx.mesh.n_nodes; ++i) {
            const double *coords = ctx.mesh.nodes_xyz.data() + static_cast<size_t>(i) * 3u;
            mesh->AddVertex(coords);
        }

        for (uint32_t i = 0; i < ctx.mesh.n_elements; ++i) {
            const uint32_t *tet = ctx.mesh.elements.data() + static_cast<size_t>(i) * 4u;
            const int vi[4] = {
                static_cast<int>(tet[0]),
                static_cast<int>(tet[1]),
                static_cast<int>(tet[2]),
                static_cast<int>(tet[3]),
            };
            int attr = 1;
            if (!ctx.mesh.element_markers.empty()) {
                const uint32_t marker = ctx.mesh.element_markers[static_cast<size_t>(i)];
                attr = marker == 0u ? 2 : static_cast<int>(marker);
            }
            mesh->AddTet(vi, attr);
        }

        for (const auto &tri : mfem_boundary_triangles) {
            const int vi[3] = {
                static_cast<int>(tri.nodes[0]),
                static_cast<int>(tri.nodes[1]),
                static_cast<int>(tri.nodes[2]),
            };
            mesh->AddBdrTriangle(vi, static_cast<int>(tri.marker));
        }

        mesh->FinalizeTopology();
        mesh->Finalize(false, true);
        debug_checkpoint("context_initialize_mfem:mesh_ready");

        auto *fec = new mfem::H1_FECollection(static_cast<int>(ctx.base_plan.fe_order), mesh->Dimension());
        auto *fes = new mfem::FiniteElementSpace(mesh, fec);
        debug_checkpoint("context_initialize_mfem:fes_ready");

        if (fes->GetNDofs() != static_cast<int>(ctx.mesh.n_nodes)) {
            error = "MFEM H1 P1 space DOF count does not match node count";
            delete fes;
            delete fec;
            delete mesh;
            return false;
        }

        unpack_aos_to_components(ctx.state.m_xyz, ctx.mfem_context.m_x, ctx.mfem_context.m_y, ctx.mfem_context.m_z);
        auto *gf_mx = new mfem::GridFunction(fes);
        auto *gf_my = new mfem::GridFunction(fes);
        auto *gf_mz = new mfem::GridFunction(fes);
        auto *gf_a = new mfem::GridFunction(fes);
        auto *gf_ms = new mfem::GridFunction(fes);
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

        const auto *runtime = ctx.material_fields.runtime
            ? &*ctx.material_fields.runtime
            : nullptr;
        const bool use_dg0_a = !ctx.material_fields.A_element_field.empty();
        const bool use_dg0_ms = !ctx.material_fields.Ms_element_field.empty();
        if ((use_dg0_a || use_dg0_ms) && runtime == nullptr) {
            error = "elementwise material coefficient requires initialized material runtime";
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
        if ((use_dg0_a && runtime->realization().a_location() != MaterialCoefficientLocation::element_dg0) ||
            (use_dg0_ms && runtime->realization().ms_location() != MaterialCoefficientLocation::element_dg0)) {
            error = "elementwise material payload does not match DG0 material realization";
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

        mfem::Coefficient *a_coeff = use_dg0_a
            ? static_cast<mfem::Coefficient *>(new AdapterBackedElementwiseCoefficient(
                  *runtime, AdapterCoefficientKind::exchange_stiffness))
            : static_cast<mfem::Coefficient *>(new mfem::GridFunctionCoefficient(gf_a));
        mfem::Coefficient *ms_coeff = use_dg0_ms
            ? static_cast<mfem::Coefficient *>(new AdapterBackedElementwiseCoefficient(
                  *runtime, AdapterCoefficientKind::saturation_magnetisation))
            : static_cast<mfem::Coefficient *>(new mfem::GridFunctionCoefficient(gf_ms));

        if (!initialize_exchange_operator_mfem(
                ctx, *mesh, *fes, *a_coeff, *ms_coeff, error)) {
            delete ms_coeff;
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
        ctx.mfem_context.mesh = mesh;
        ctx.mfem_context.fec = fec;
        ctx.mfem_context.fes = fes;
        ctx.mfem_context.gf_mx = gf_mx;
        ctx.mfem_context.gf_my = gf_my;
        ctx.mfem_context.gf_mz = gf_mz;
        ctx.mfem_context.gf_a = gf_a;
        ctx.mfem_context.gf_ms = gf_ms;
        ctx.mfem_context.a_coeff = a_coeff;
        ctx.mfem_context.ms_coeff = ms_coeff;
        ctx.mfem_context.ready = true;
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
    // Do not delete the global mfem::Device virtual singleton to prevent invalidating
    // the MemoryManager device environment for subsequent context instances in this process.
    // delete ctx.mfem_context.device;
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
    ctx.exchange.mfem.consistent_mass_solver = nullptr;
    ctx.mfem_context.gf_ms = nullptr;
    ctx.mfem_context.gf_a = nullptr;
    ctx.mfem_context.gf_mz = nullptr;
    ctx.mfem_context.gf_my = nullptr;
    ctx.mfem_context.gf_mx = nullptr;
    ctx.mfem_context.fes = nullptr;
    ctx.mfem_context.fec = nullptr;
    ctx.mfem_context.mesh = nullptr;
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

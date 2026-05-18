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
#include "cpu/mfem/runtime/aos_field.hpp"
#include "cpu/mfem/runtime/cpu_threads.hpp"
#include "cpu/mfem/runtime/mfem_device.hpp"
#include "fem_common.hpp"
#include "transfer_audit.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <optional>
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

bool env_flag_enabled(const char *name)
{
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

void debug_checkpoint(const char *stage)
{
    if (!env_flag_enabled("FULLMAG_FEM_DEBUG_STARTUP")) {
        return;
    }
    std::fprintf(stderr, "[fullmag_fem][debug] %s\n", stage);
    std::fflush(stderr);
}

uint64_t vector_bytes(const mfem::Vector &vector)
{
    return static_cast<uint64_t>(std::max(vector.Size(), 0)) * sizeof(double);
}

double *audited_host_write(mfem::Vector &vector)
{
    record_mfem_host_write(vector_bytes(vector));
    return vector.HostWrite();
}

} // namespace

bool context_initialize_mfem(Context &ctx, std::string &error)
{
    try {
        debug_checkpoint("context_initialize_mfem:enter");
        static std::once_flag s_mfem_device_once;
#if FULLMAG_HAS_CUDA_RUNTIME
        const char *device_config = configured_mfem_device_string(ctx);
        const bool use_gpu_device = is_gpu_device_string(device_config);
        if (use_gpu_device) {
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
            std::call_once(s_mfem_device_once, [&, device_config]() {
                ctx.mfem_context.device = new mfem::Device(device_config);
            });
            ctx.mfem_context.selected_device_index = selected_device;

            int low_priority = 0;
            int high_priority = 0;
            cudaDeviceGetStreamPriorityRange(&low_priority, &high_priority);
            cudaStream_t cs{};
            cudaStream_t ios{};
            cudaStreamCreateWithPriority(&cs, cudaStreamNonBlocking, high_priority);
            cudaStreamCreateWithPriority(&ios, cudaStreamNonBlocking, low_priority);
            ctx.cuda_runtime.compute_stream = reinterpret_cast<void *>(cs);
            ctx.cuda_runtime.io_stream = reinterpret_cast<void *>(ios);
            cudaEvent_t ev{};
            cudaEventCreateWithFlags(&ev, cudaEventDisableTiming);
            ctx.cuda_runtime.compute_event = reinterpret_cast<void *>(ev);
        } else {
            configure_cpu_openmp_runtime(ctx);
            const char *host_device = (device_config != nullptr && *device_config != '\0')
                ? device_config : "cpu";
            std::call_once(s_mfem_device_once, [&ctx, host_device]() {
                ctx.mfem_context.device = new mfem::Device(host_device);
            });
            ctx.mfem_context.selected_device_index = -1;
            log_cpu_runtime_selection(ctx);
        }
#else
        configure_cpu_openmp_runtime(ctx);
        std::call_once(s_mfem_device_once, [&ctx]() {
            ctx.mfem_context.device = new mfem::Device("cpu");
        });
        ctx.mfem_context.selected_device_index = -1;
        log_cpu_runtime_selection(ctx);
#endif

        debug_checkpoint("context_initialize_mfem:device_ready");
        auto *mesh = new mfem::Mesh(3, static_cast<int>(ctx.n_nodes), static_cast<int>(ctx.n_elements),
                                    static_cast<int>(ctx.n_boundary_faces), 3);

        for (uint32_t i = 0; i < ctx.n_nodes; ++i) {
            const double *coords = ctx.mesh.nodes_xyz.data() + static_cast<size_t>(i) * 3u;
            mesh->AddVertex(coords);
        }

        for (uint32_t i = 0; i < ctx.n_elements; ++i) {
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

        for (uint32_t i = 0; i < ctx.n_boundary_faces; ++i) {
            const uint32_t *tri = ctx.mesh.boundary_faces.data() + static_cast<size_t>(i) * 3u;
            const int vi[3] = {
                static_cast<int>(tri[0]),
                static_cast<int>(tri[1]),
                static_cast<int>(tri[2]),
            };
            const int attr = ctx.mesh.boundary_markers.empty()
                ? 1
                : static_cast<int>(ctx.mesh.boundary_markers[static_cast<size_t>(i)]);
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

        unpack_aos_to_components(ctx.state.m_xyz, ctx.mfem_mx, ctx.mfem_my, ctx.mfem_mz);
        auto *gf_mx = new mfem::GridFunction(fes);
        auto *gf_my = new mfem::GridFunction(fes);
        auto *gf_mz = new mfem::GridFunction(fes);
        auto *gf_a = new mfem::GridFunction(fes);
        auto *gf_ms = new mfem::GridFunction(fes);
        auto *a_coeff = new mfem::GridFunctionCoefficient(gf_a);
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
                ctx.material_fields.A_field,
                static_cast<size_t>(i),
                ctx.material.exchange_stiffness);
            ms_host[i] = scalar_field_value(
                ctx.material_fields.Ms_field,
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
    context_destroy_demag_fem_bem(ctx);
    context_destroy_poisson(ctx);
    destroy_dmi_workspace(ctx);

    delete static_cast<mfem::Coefficient *>(ctx.mfem_a_coeff);
    delete static_cast<mfem::Vector *>(ctx.exchange.mfem.out_vec);
    delete static_cast<mfem::Vector *>(ctx.exchange.mfem.tmp_vec);
    delete static_cast<mfem::Vector *>(ctx.exchange.mfem.inv_lumped_mass);
    delete static_cast<mfem::Vector *>(ctx.exchange.mfem.mass_lumped);
    delete static_cast<mfem::Vector *>(ctx.exchange.mfem.mass_ones);
    delete static_cast<mfem::BilinearForm *>(ctx.exchange.mfem.mass_form);
    delete static_cast<mfem::BilinearForm *>(ctx.exchange.mfem.exchange_form);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_gf_ms);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_gf_a);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_gf_mz);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_gf_my);
    delete static_cast<mfem::GridFunction *>(ctx.mfem_gf_mx);
    delete static_cast<mfem::FiniteElementSpace *>(ctx.mfem_fes);
    delete static_cast<mfem::FiniteElementCollection *>(ctx.mfem_fec);
    delete static_cast<mfem::Mesh *>(ctx.mfem_mesh);
    ctx.mfem_context.device = nullptr;
    ctx.exchange.mfem.mass_form = nullptr;
    ctx.exchange.mfem.exchange_form = nullptr;
    ctx.mfem_a_coeff = nullptr;
    ctx.exchange.mfem.out_vec = nullptr;
    ctx.exchange.mfem.tmp_vec = nullptr;
    ctx.exchange.mfem.inv_lumped_mass = nullptr;
    ctx.exchange.mfem.mass_lumped = nullptr;
    ctx.exchange.mfem.mass_ones = nullptr;
    ctx.mfem_gf_ms = nullptr;
    ctx.mfem_gf_a = nullptr;
    ctx.mfem_gf_mz = nullptr;
    ctx.mfem_gf_my = nullptr;
    ctx.mfem_gf_mx = nullptr;
    ctx.mfem_fes = nullptr;
    ctx.mfem_fec = nullptr;
    ctx.mfem_mesh = nullptr;
    ctx.mfem_ready = false;
    ctx.exchange.mfem.ready = false;
    ctx.gpu_exchange.legacy_sparse_metadata_ready = false;
    ctx.gpu_exchange.legacy_sparse_rows = 0;
    ctx.gpu_exchange.legacy_sparse_cols = 0;
    ctx.gpu_exchange.legacy_sparse_nnz = 0;
    ctx.gpu_exchange.lumped_mass_ready = false;

#if FULLMAG_HAS_CUDA_RUNTIME
    if (ctx.cuda_runtime.compute_stream != nullptr) {
        cudaStreamDestroy(reinterpret_cast<cudaStream_t>(ctx.cuda_runtime.compute_stream));
        ctx.cuda_runtime.compute_stream = nullptr;
    }
    if (ctx.cuda_runtime.io_stream != nullptr) {
        cudaStreamDestroy(reinterpret_cast<cudaStream_t>(ctx.cuda_runtime.io_stream));
        ctx.cuda_runtime.io_stream = nullptr;
    }
    if (ctx.cuda_runtime.compute_event != nullptr) {
        cudaEventDestroy(reinterpret_cast<cudaEvent_t>(ctx.cuda_runtime.compute_event));
        ctx.cuda_runtime.compute_event = nullptr;
    }
    for (auto &buf : ctx.cuda_runtime.pinned_snapshot) {
        if (buf != nullptr) {
            cudaFreeHost(buf);
            buf = nullptr;
        }
    }
    ctx.cuda_runtime.pinned_snapshot_bytes = 0;
#endif
}
#endif

} // namespace fullmag::fem

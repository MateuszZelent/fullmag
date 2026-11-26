/*
 * Device-resident CUDA contracts for the Fredkin-Koehler FEM/BEM runtime:
 * - Source contracts for AMG coarse relax_type=18, HypreStreamInterop,
 *   certification_solver_tolerance (0.1*rtol), shared multi-block residual
 *   certification, cuDSS pinning on hypre_stream, and receipt bit separation.
 * - Device BEM apply kernel contract.
 * - Runtime GPU FEM/BEM AMG (relax_type=18, parity <= 1e-8, 2 fences / 32 B)
 *   and cuDSS / atomic VRAM-fallback pair contracts.
 */

#include "context.hpp"
#include "core/demag_solver_policy.hpp"
#include "cpu/mfem/interactions/demag_fem_bem.hpp"
#include "gpu/cuda/demag_fem_bem/fem_bem.hpp"
#include "gpu/cuda/demag_fem_bem/fem_bem_kernels.hpp"
#include "gpu/cuda/demag_poisson/cudss_direct_solver.hpp"
#include "gpu/cuda/runtime/execution_receipt.hpp"
#include "gpu/cuda/runtime/performance_counters.hpp"
#include "gpu/cuda/state/gpu_state.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace {

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void check_result(bool condition, const std::string &error, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s: %s\n", message, error.c_str());
        std::exit(1);
    }
}

std::string read_text_file(const std::filesystem::path &path) {
    std::ifstream in(path);
    if (!in) {
        std::fprintf(stderr, "FAIL: unable to read %s\n", path.string().c_str());
        std::exit(1);
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

std::filesystem::path fem_source_root() {
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

void fem_bem_gpu_source_contract() {
    const std::filesystem::path root = fem_source_root();
    const std::string header =
        read_text_file(root / "gpu" / "cuda" / "demag_fem_bem" / "fem_bem.hpp");
    const std::string source =
        read_text_file(root / "gpu" / "cuda" / "demag_fem_bem" / "fem_bem.cpp");

    check(
        header.find("std::shared_ptr<GpuDemagCudssDirectSolver> direct_solver;") !=
                std::string::npos &&
            header.find("HypreStreamInterop stream_interop{};") != std::string::npos &&
            header.find("GpuValidationNormScratch validation_scratch{};") != std::string::npos &&
            header.find("GpuDemagCudssResolution cudss_resolution{};") != std::string::npos &&
            header.find("gpu_demag_fem_bem_amg_coarse_relax_type(") != std::string::npos &&
            header.find("gpu_demag_fem_bem_linear_solver(") != std::string::npos &&
            header.find("gpu_demag_fem_bem_cudss_resolution(") != std::string::npos,
        "GPU FEM/BEM header must declare stream interop, norm scratch, cuDSS handles, and getters");

    check(
        source.find("HYPRE_BoomerAMGSetCycleRelaxType(amgraw, 18, 3)") != std::string::npos &&
            source.find("HYPRE_BoomerAMGGetCycleRelaxType(") != std::string::npos,
        "GPU FEM/BEM AMG configuration must set and verify coarse relax_type=18");

    const size_t init_pos = source.find("bool initialize_linear_system(");
    const size_t cfg_pos = source.find("bool configure_solver_initial_iterate(", init_pos);
    const size_t stats_pos = source.find("void read_solver_statistics(", cfg_pos);
    const size_t solve_pos = source.find("bool solve_linear_system(", stats_pos);
    const size_t solve_end = source.find("#endif", solve_pos);
    check(
        init_pos != std::string::npos &&
            cfg_pos != std::string::npos &&
            stats_pos != std::string::npos &&
            solve_pos != std::string::npos &&
            solve_end != std::string::npos &&
            init_pos < cfg_pos && cfg_pos < stats_pos &&
            stats_pos < solve_pos && solve_pos < solve_end,
        "GPU FEM/BEM linear-system helpers must remain discoverable and CUDA/MFEM/MPI guarded");

    const std::string init_body = source.substr(init_pos, cfg_pos - init_pos);
    const std::string cfg_body = source.substr(cfg_pos, stats_pos - cfg_pos);
    const std::string solve_body = source.substr(solve_pos, solve_end - solve_pos);
    check(
        init_body.find("certification_solver_tolerance(") != std::string::npos &&
            cfg_body.find("certification_solver_tolerance(") != std::string::npos,
        "GPU FEM/BEM must apply certification_solver_tolerance (0.1*rtol) in init and solve config");

    check(
        solve_body.find("cudaStreamSynchronize(") == std::string::npos &&
            solve_body.find("Norml2()") == std::string::npos &&
            solve_body.find("->Add(-1.0,") == std::string::npos,
        "GPU FEM/BEM solve_linear_system must not call raw cudaStreamSynchronize, Norml2(), or default-stream Add");

    check(
        solve_body.find("hypre_wait_for_fullmag(") != std::string::npos &&
            solve_body.find("fullmag_wait_for_hypre(") != std::string::npos &&
            solve_body.find("certify_gpu_hypre_demag_residual(") != std::string::npos &&
            solve_body.find("solve_demag_cudss_direct(") != std::string::npos &&
            solve_body.find("workspace.stream_interop.hypre_stream") != std::string::npos &&
            solve_body.find("FEM_GPU_OPERATOR_DIRECT_SOLVE") != std::string::npos &&
            solve_body.find("FEM_GPU_OPERATOR_PRECONDITIONER") != std::string::npos,
        "GPU FEM/BEM solve_linear_system must use HypreStreamInterop, shared certification, cuDSS on hypre_stream, and conditional receipt bits");

    const size_t gpu_init_pos = source.find("bool gpu_demag_fem_bem_initialize(");
    const size_t gpu_destroy_pos = source.find("void gpu_demag_fem_bem_destroy(", gpu_init_pos);
    check(
        gpu_init_pos != std::string::npos && gpu_destroy_pos != std::string::npos &&
            source.substr(gpu_init_pos, gpu_destroy_pos - gpu_init_pos)
                    .find("try_initialize_fem_bem_cudss_pair(") != std::string::npos,
        "GPU FEM/BEM initialize must use atomic try_initialize_fem_bem_cudss_pair");

    const size_t stage_pos =
        source.find("bool compute_device_demag_fem_bem_for_device_stage(");
    const size_t recover_pos =
        source.find("bool recover_device_demag_fem_bem_field_device(", stage_pos);
    check(
        stage_pos != std::string::npos && recover_pos != std::string::npos,
        "GPU FEM/BEM stage compute function must be discoverable");
    const std::string stage_body = source.substr(stage_pos, recover_pos - stage_pos);
    check(
        stage_body.find("FEM_GPU_OPERATOR_PRECONDITIONER") == std::string::npos &&
            stage_body.find("FEM_GPU_OPERATOR_DEMAG_RHS") != std::string::npos &&
            stage_body.find("FEM_GPU_OPERATOR_DEMAG_SOLVE") != std::string::npos &&
            stage_body.find("FEM_GPU_OPERATOR_DEMAG_RECOVERY") != std::string::npos,
        "GPU FEM/BEM stage compute must not unconditionally emit FEM_GPU_OPERATOR_PRECONDITIONER");
}

#if FULLMAG_HAS_CUDA_RUNTIME
template <typename T>
T *upload(const std::vector<T> &values) {
    T *device = nullptr;
    check(
        cudaMalloc(reinterpret_cast<void **>(&device), values.size() * sizeof(T)) == cudaSuccess,
        "CUDA test allocation");
    check(
        cudaMemcpy(device, values.data(), values.size() * sizeof(T), cudaMemcpyHostToDevice) ==
            cudaSuccess,
        "CUDA test upload");
    return device;
}

void device_bem_apply_is_device_resident() {
    const std::vector<uint32_t> near_offsets = {0u, 1u, 2u};
    const std::vector<uint32_t> near_columns = {0u, 1u};
    const std::vector<double> near_values = {2.0, 3.0};
    const std::vector<fullmag::fem::HierarchicalDemagBemFarBlock> far_blocks = {
        {0u, 2u, 0u, 2u, 1u, 0u, 0u},
    };
    const std::vector<double> far_u = {1.0, 2.0};
    const std::vector<double> far_v = {4.0, 5.0};
    const std::vector<uint32_t> permutation = {0u, 1u};
    const std::vector<uint32_t> boundary_tdofs = {3u, 5u};
    const std::vector<double> u1_full = {0.0, 0.0, 0.0, 1.0, 0.0, 2.0};

    uint32_t *d_near_offsets = upload(near_offsets);
    uint32_t *d_near_columns = upload(near_columns);
    double *d_near_values = upload(near_values);
    auto *d_far_blocks = upload(far_blocks);
    double *d_far_u = upload(far_u);
    double *d_far_v = upload(far_v);
    uint32_t *d_permutation = upload(permutation);
    uint32_t *d_boundary_tdofs = upload(boundary_tdofs);
    double *d_u1_full = upload(u1_full);
    double *d_output = nullptr;
    check(cudaMalloc(reinterpret_cast<void **>(&d_output), 2u * sizeof(double)) == cudaSuccess,
          "CUDA test output allocation");

    fullmag::fem::fullmag_cuda_fem_bem_apply(
        d_near_offsets,
        d_near_columns,
        d_near_values,
        d_far_blocks,
        d_far_u,
        d_far_v,
        d_permutation,
        d_boundary_tdofs,
        d_u1_full,
        d_output,
        2,
        1,
        1,
        nullptr);
    check(cudaGetLastError() == cudaSuccess, "CUDA BEM apply launch");
    check(cudaDeviceSynchronize() == cudaSuccess, "CUDA BEM apply synchronization");
    std::vector<double> output(2u, 0.0);
    check(cudaMemcpy(output.data(), d_output, 2u * sizeof(double), cudaMemcpyDeviceToHost) ==
              cudaSuccess,
          "CUDA BEM apply readback");
    check(output[0] == 16.0 && output[1] == 34.0,
          "CUDA BEM apply matches near plus low-rank reference");

    cudaFree(d_near_offsets);
    cudaFree(d_near_columns);
    cudaFree(d_near_values);
    cudaFree(d_far_blocks);
    cudaFree(d_far_u);
    cudaFree(d_far_v);
    cudaFree(d_permutation);
    cudaFree(d_boundary_tdofs);
    cudaFree(d_u1_full);
    cudaFree(d_output);
}
#endif

#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
struct ScopedEnvVar {
    std::string name;
    bool had_previous = false;
    std::string previous;

    explicit ScopedEnvVar(const char *env_name) : name(env_name) {
        const char *value = std::getenv(env_name);
        if (value != nullptr) {
            had_previous = true;
            previous = value;
        }
    }

    void set(const char *value) const {
        check(setenv(name.c_str(), value, 1) == 0, "set scoped environment variable");
    }

    void unset() const {
        check(unsetenv(name.c_str()) == 0, "unset scoped environment variable");
    }

    ~ScopedEnvVar() {
        if (had_previous) {
            setenv(name.c_str(), previous.c_str(), 1);
        } else {
            unsetenv(name.c_str());
        }
    }
};

std::vector<double> build_body_only_tet_cube_context(
    fullmag::fem::Context &ctx,
    mfem::Mesh &mesh,
    mfem::FiniteElementSpace &fes)
{
    ctx.base_plan.fe_order = 1u;
    ctx.mfem_context.mesh = &mesh;
    ctx.mfem_context.fes = &fes;
    ctx.mesh.n_nodes = static_cast<uint32_t>(mesh.GetNV());
    ctx.mesh.n_elements = static_cast<uint32_t>(mesh.GetNE());
    ctx.mesh.nodes_xyz.clear();
    ctx.mesh.nodes_xyz.reserve(static_cast<size_t>(mesh.GetNV()) * 3u);
    for (int node = 0; node < mesh.GetNV(); ++node) {
        const double *vertex = mesh.GetVertex(node);
        ctx.mesh.nodes_xyz.insert(ctx.mesh.nodes_xyz.end(), vertex, vertex + 3);
    }
    ctx.mesh.cell_types.assign(static_cast<size_t>(mesh.GetNE()), FULLMAG_FEM_CELL_TET4);
    ctx.mesh.cell_offsets = {0u};
    ctx.mesh.cell_nodes.clear();
    ctx.mesh.cell_global_ordinals.clear();
    ctx.mesh.cell_markers.assign(static_cast<size_t>(mesh.GetNE()), 1u);
    ctx.mesh.magnetic_element_mask.assign(static_cast<size_t>(mesh.GetNE()), 1u);
    ctx.mesh.magnetic_node_mask.assign(static_cast<size_t>(mesh.GetNV()), 1u);
    for (int element = 0; element < mesh.GetNE(); ++element) {
        ctx.mesh.cell_global_ordinals.push_back(static_cast<uint64_t>(element));
        mfem::Array<int> vertices;
        mesh.GetElementVertices(element, vertices);
        for (int vertex : vertices) {
            ctx.mesh.cell_nodes.push_back(static_cast<uint32_t>(vertex));
        }
        ctx.mesh.cell_offsets.push_back(static_cast<uint32_t>(ctx.mesh.cell_nodes.size()));
    }
    std::string map_error;
    check_result(
        ctx.mfem_context.marker_maps.domain.assign(ctx.mesh.cell_markers, map_error),
        map_error,
        "FEM/BEM GPU contract domain marker map");
    for (int i = 0; i < mesh.GetNE(); ++i) {
        mesh.GetElement(i)->SetAttribute(
            ctx.mfem_context.marker_maps.domain.attribute(ctx.mesh.cell_markers[i]));
    }

    mfem::BilinearForm mass_form(&fes);
    mass_form.AddDomainIntegrator(new mfem::MassIntegrator());
    mass_form.Assemble();
    mass_form.Finalize();
    const mfem::SparseMatrix &mass_mat = mass_form.SpMat();
    ctx.integration_weights.mfem_lumped_mass.assign(static_cast<size_t>(mesh.GetNV()), 0.0);
    const int *row_offsets = mass_mat.GetI();
    const double *mass_values = mass_mat.GetData();
    for (int row = 0; row < mass_mat.Height(); ++row) {
        double sum = 0.0;
        for (int cursor = row_offsets[row]; cursor < row_offsets[row + 1]; ++cursor) {
            sum += mass_values[cursor];
        }
        ctx.integration_weights.mfem_lumped_mass[static_cast<size_t>(row)] = sum;
    }
    ctx.mesh.node_volumes = ctx.integration_weights.mfem_lumped_mass;

    ctx.material_fields.material.saturation_magnetisation = 8.0e5;
    ctx.demag.enabled = true;
    ctx.demag.realization = FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER;
    ctx.demag.solver.solver = FULLMAG_FEM_LINEAR_SOLVER_CG;
    ctx.demag.solver.preconditioner = FULLMAG_FEM_PRECONDITIONER_AMG;
    ctx.demag.solver.relative_tolerance = 1.0e-12;
    ctx.demag.solver.has_absolute_tolerance = 0;
    ctx.demag.solver.absolute_tolerance = 0.0;
    ctx.demag.solver.max_iterations = 500;
    ctx.demag.solver.print_level = 0;
    ctx.demag.amg_policy = fullmag::fem::resolve_demag_amg_policy_from_environment();
    ctx.cpu_threads.effective_omp_threads = 1;

    std::vector<double> m_xyz(static_cast<size_t>(mesh.GetNV()) * 3u, 0.0);
    for (int node = 0; node < mesh.GetNV(); ++node) {
        const double *v = mesh.GetVertex(node);
        const double mx = 0.8 + 0.15 * std::sin(v[0] * 1.0e8);
        const double my = 0.3 + 0.1 * std::cos(v[1] * 1.0e8);
        const double mz = 0.2 + 0.1 * (v[2] * 1.0e8);
        const double inv_norm = 1.0 / std::sqrt(mx * mx + my * my + mz * mz);
        m_xyz[3u * static_cast<size_t>(node) + 0u] = mx * inv_norm;
        m_xyz[3u * static_cast<size_t>(node) + 1u] = my * inv_norm;
        m_xyz[3u * static_cast<size_t>(node) + 2u] = mz * inv_norm;
    }
    return m_xyz;
}

double max_relative_field_error(
    const std::vector<double> &candidate,
    const std::vector<double> &reference)
{
    check(candidate.size() == reference.size(), "FEM/BEM field extents must match");
    double max_abs_diff = 0.0;
    double max_ref = 1.0;
    for (size_t i = 0; i < reference.size(); ++i) {
        check(std::isfinite(candidate[i]) && std::isfinite(reference[i]),
              "FEM/BEM field values must be finite");
        max_abs_diff = std::max(max_abs_diff, std::abs(candidate[i] - reference[i]));
        max_ref = std::max(max_ref, std::abs(reference[i]));
    }
    return max_abs_diff / max_ref;
}

void run_gpu_fem_bem_case(
    fullmag::fem::GpuDemagSolverStrategy strategy,
    const std::vector<double> &cpu_h_demag,
    double cpu_energy,
    bool expect_init_failure,
    bool expect_cudss_fallback_budget)
{
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        2, 2, 2, mfem::Element::TETRAHEDRON, 20.0e-9, 20.0e-9, 10.0e-9);
    mfem::H1_FECollection fec(1, 3);
    mfem::FiniteElementSpace fes(&mesh, &fec);
    fullmag::fem::Context ctx;
    const std::vector<double> m_xyz = build_body_only_tet_cube_context(ctx, mesh, fes);
    ctx.poisson_demag.gpu_demag_mode = FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_FEM_BEM;
    ctx.poisson_demag.gpu_solver_strategy = strategy;

    std::string error;
    check_result(
        fullmag::fem::context_initialize_demag_fem_bem(ctx, error),
        error,
        "GPU FEM/BEM contract initializes CPU geometry/workspace");
    check_result(
        fullmag::fem::gpu_state_initialize(
            ctx.gpu_state.device,
            ctx.mesh.n_nodes,
            FULLMAG_FEM_INTEGRATOR_HEUN,
            true,
            true,
            m_xyz.data(),
            m_xyz.size(),
            ctx.transfer_audit.audit,
            error),
        error,
        "GPU FEM/BEM contract allocates GPU state");
    check_result(
        fullmag::fem::gpu_state_upload_runtime_coefficients(
            ctx.gpu_state.device,
            ctx.mesh.node_volumes.data(), ctx.mesh.node_volumes.size(),
            nullptr, 0u, ctx.material_fields.material.saturation_magnetisation,
            nullptr, 0u, 0.0,
            nullptr, 0u, 0.02,
            nullptr, 0u,
            nullptr, 0u,
            nullptr, 0u, 1.0,
            nullptr, 0u, 0.0,
            nullptr, 0u, 0.0,
            nullptr, 0u,
            nullptr, 0u,
            nullptr, 0u,
            nullptr, 0u,
            nullptr, 0u,
            ctx.mesh.magnetic_node_mask.data(), ctx.mesh.magnetic_node_mask.size(),
            nullptr, 0u,
            nullptr, 0u,
            ctx.transfer_audit.audit,
            error),
        error,
        "GPU FEM/BEM contract uploads runtime coefficients");

    const bool init_ok = fullmag::fem::gpu_demag_fem_bem_initialize(ctx, error);
    if (expect_init_failure) {
        check(!init_ok && !fullmag::fem::gpu_demag_fem_bem_ready(ctx),
              "GPU FEM/BEM forced cuDSS over tight VRAM budget must fail hard without fallback");
        fullmag::fem::gpu_demag_fem_bem_destroy(ctx);
        fullmag::fem::gpu_state_destroy(ctx.gpu_state.device);
        fullmag::fem::context_destroy_demag_fem_bem(ctx);
        return;
    }
    check_result(init_ok, error, "GPU FEM/BEM workspace initialization");
    check(fullmag::fem::gpu_demag_fem_bem_ready(ctx), "GPU FEM/BEM workspace must be ready");

    const auto resolved_solver = fullmag::fem::gpu_demag_fem_bem_linear_solver(ctx);
    fullmag::fem::GpuDemagCudssResolution resolution{};
    check(fullmag::fem::gpu_demag_fem_bem_cudss_resolution(ctx, resolution),
          "GPU FEM/BEM workspace publishes cuDSS resolution metadata");

    std::int32_t coarse_relax_type = 0;
    check_result(
        fullmag::fem::gpu_demag_fem_bem_amg_coarse_relax_type(ctx, coarse_relax_type, error),
        error,
        "GPU FEM/BEM AMG coarse relax type query");

    const bool is_direct =
        resolved_solver == fullmag::fem::GpuDemagPoissonLinearSolver::CudssDirect;
    if (strategy == fullmag::fem::GpuDemagSolverStrategy::CgAmg) {
        check(!is_direct &&
                  resolved_solver == fullmag::fem::GpuDemagPoissonLinearSolver::HypreKrylov,
              "GPU FEM/BEM CgAmg strategy must resolve to HypreKrylov");
        check(coarse_relax_type == 18,
              "GPU FEM/BEM AMG coarse relax_type must equal 18 under CgAmg");
    } else if (expect_cudss_fallback_budget) {
        check(!is_direct &&
                  resolved_solver == fullmag::fem::GpuDemagPoissonLinearSolver::HypreKrylov,
              "GPU FEM/BEM Auto under tight VRAM cap must atomically fall back to HypreKrylov");
        check(!resolution.resolved_direct &&
                  (resolution.fallback_reason ==
                       fullmag::fem::GpuDemagFallbackReason::CudssFactorExceedsVramBudget ||
                   resolution.fallback_reason ==
                       fullmag::fem::GpuDemagFallbackReason::CudssUnavailable),
              "GPU FEM/BEM Auto fallback must report VRAM budget or cuDSS unavailable reason");
        check(coarse_relax_type == 18,
              "GPU FEM/BEM AMG coarse relax_type must equal 18 after atomic fallback");
    } else if (is_direct) {
        check(resolution.resolved_direct &&
                  resolution.fallback_reason == fullmag::fem::GpuDemagFallbackReason::None,
              "GPU FEM/BEM cuDSS direct solve must report resolved_direct with no fallback");
        check(coarse_relax_type == -1,
              "GPU FEM/BEM cuDSS direct solve must report coarse_relax_type == -1");
    } else {
        check(coarse_relax_type == 18,
              "GPU FEM/BEM fallback to AMG must report coarse_relax_type == 18");
    }

    const uint64_t expected_linear_bit = is_direct
        ? fullmag::fem::FEM_GPU_OPERATOR_DIRECT_SOLVE
        : fullmag::fem::FEM_GPU_OPERATOR_PRECONDITIONER;
    const uint64_t forbidden_linear_bit = is_direct
        ? fullmag::fem::FEM_GPU_OPERATOR_PRECONDITIONER
        : fullmag::fem::FEM_GPU_OPERATOR_DIRECT_SOLVE;
    const uint64_t required_mask =
        fullmag::fem::FEM_GPU_OPERATOR_DEMAG_RHS |
        fullmag::fem::FEM_GPU_OPERATOR_DEMAG_SOLVE |
        fullmag::fem::FEM_GPU_OPERATOR_DEMAG_RECOVERY |
        expected_linear_bit;
    fullmag::fem::gpu_execution_receipt_resolve_plan(
        ctx.gpu_state.execution_receipt,
        required_mask,
        required_mask,
        0u,
        0u,
        fullmag::fem::FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);

    cudaStream_t stream = nullptr;
    check(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking) == cudaSuccess,
          "GPU FEM/BEM contract creates non-blocking stream");

    ctx.transfer_audit.audit.assert_no_hot_loop_host_sync = true;
    ctx.transfer_audit.audit.assert_no_hot_loop_compute_sync = true;
    const auto audit_before = fullmag::fem::transfer_audit_snapshot(ctx.transfer_audit.audit);
    const auto perf_before =
        fullmag::fem::gpu_performance_snapshot(ctx.gpu_state.performance_counters);
    fullmag::fem::gpu_execution_receipt_begin_attempt(
        ctx.gpu_state.execution_receipt, audit_before);
    fullmag::fem::gpu_performance_begin_attempt(ctx.gpu_state.performance_counters, 1u);
    {
        fullmag::fem::TransferAuditScope hot_loop(
            ctx.transfer_audit.audit,
            fullmag::fem::TransferAuditScopeKind::HotLoop);
        check_result(
            fullmag::fem::compute_device_demag_fem_bem_for_device_stage(
                ctx,
                ctx.gpu_state.device.magnetization.m,
                stream,
                true,
                true,
                error),
            error,
            "GPU FEM/BEM stage solve");
    }
    check(cudaStreamSynchronize(stream) == cudaSuccess,
          "GPU FEM/BEM contract synchronizes stream after solve");
    const auto audit_after = fullmag::fem::transfer_audit_snapshot(ctx.transfer_audit.audit);
    check(fullmag::fem::gpu_execution_receipt_update_attempt_transfer(
              ctx.gpu_state.execution_receipt, audit_after),
          "GPU FEM/BEM hot-loop must stay free of bulk compute transfers");
    fullmag::fem::gpu_execution_receipt_commit_attempt(ctx.gpu_state.execution_receipt);
    fullmag::fem::gpu_performance_commit_attempt(ctx.gpu_state.performance_counters);

    const auto receipt = fullmag::fem::gpu_execution_receipt_snapshot(ctx.gpu_state.execution_receipt);
    check(receipt.accounting_valid &&
              receipt.execution_class == fullmag::fem::FemGpuExecutionClass::DeviceResident &&
              (receipt.executed_device_operator_mask & expected_linear_bit) != 0u &&
              (receipt.executed_device_operator_mask & forbidden_linear_bit) == 0u,
          "GPU FEM/BEM receipt must emit only the active linear-solver bit without conflict");

    const uint64_t control_fences =
        audit_after.hot_loop_control_scalar_host_sync_count -
        audit_before.hot_loop_control_scalar_host_sync_count;
    const uint64_t control_bytes =
        audit_after.hot_loop_control_scalar_d2h_bytes -
        audit_before.hot_loop_control_scalar_d2h_bytes;
    const auto perf_after =
        fullmag::fem::gpu_performance_snapshot(ctx.gpu_state.performance_counters);
    check(control_fences == 2u && control_bytes == 4u * sizeof(double) &&
              perf_after.physical_control_fences - perf_before.physical_control_fences == 2u &&
              perf_after.physical_control_d2h_bytes - perf_before.physical_control_d2h_bytes ==
                  4u * sizeof(double),
          "GPU FEM/BEM must execute exactly 1 fence / 16 B per system (2 fences / 32 B total for u1 and u2)");
    check(audit_after.hot_loop_compute_h2d_bytes == audit_before.hot_loop_compute_h2d_bytes &&
              audit_after.hot_loop_compute_d2h_bytes == audit_before.hot_loop_compute_d2h_bytes &&
              audit_after.hot_loop_compute_host_sync_count ==
                  audit_before.hot_loop_compute_host_sync_count,
          "GPU FEM/BEM must have zero hot-loop bulk compute transfers or host syncs");

    std::vector<double> gpu_h_demag;
    check_result(
        fullmag::fem::gpu_state_download_component_aos(
            ctx.gpu_state.device,
            ctx.gpu_state.device.fields.h_demag,
            gpu_h_demag,
            ctx.transfer_audit.audit,
            "GPU FEM/BEM H_demag parity",
            error),
        error,
        "GPU FEM/BEM H_demag download");
    double gpu_energy = 0.0;
    check(cudaMemcpy(
              &gpu_energy,
              ctx.gpu_state.device.reductions.scalar_result,
              sizeof(double),
              cudaMemcpyDeviceToHost) == cudaSuccess,
          "GPU FEM/BEM energy download");

    const double rel_field_err = max_relative_field_error(gpu_h_demag, cpu_h_demag);
    const double rel_energy_err =
        std::abs(gpu_energy - cpu_energy) / std::max(1.0e-30, std::abs(cpu_energy));
    check(rel_field_err <= 1.0e-8 && rel_energy_err <= 1.0e-8,
          "GPU FEM/BEM H_demag and energy must match CPU FEM/BEM within 1e-8");

    cudaStreamDestroy(stream);
    fullmag::fem::gpu_demag_fem_bem_destroy(ctx);
    fullmag::fem::gpu_state_destroy(ctx.gpu_state.device);
    fullmag::fem::context_destroy_demag_fem_bem(ctx);
}

void fem_bem_gpu_runtime_contract() {
    ScopedEnvVar env_solver(fullmag::fem::kDemagGpuDirectSolverEnv);
    ScopedEnvVar env_budget(fullmag::fem::kDemagCudssDeviceBudgetCapEnv);
    ScopedEnvVar env_mib(fullmag::fem::kDemagCudssMaxVramMibEnv);
    env_solver.unset();
    env_budget.unset();
    env_mib.unset();

    // Compute and destroy CPU FEM/BEM oracle BEFORE activating MFEM's CUDA backend.
    std::vector<double> cpu_h_demag;
    double cpu_energy = 0.0;
    {
        mfem::Mesh cpu_mesh = mfem::Mesh::MakeCartesian3D(
            2, 2, 2, mfem::Element::TETRAHEDRON, 20.0e-9, 20.0e-9, 10.0e-9);
        mfem::H1_FECollection cpu_fec(1, 3);
        mfem::FiniteElementSpace cpu_fes(&cpu_mesh, &cpu_fec);
        fullmag::fem::Context cpu_ctx;
        const std::vector<double> m_xyz =
            build_body_only_tet_cube_context(cpu_ctx, cpu_mesh, cpu_fes);
        std::string error;
        check_result(
            fullmag::fem::context_initialize_demag_fem_bem(cpu_ctx, error),
            error,
            "CPU FEM/BEM oracle initialization");
        check_result(
            fullmag::fem::context_compute_demag_fem_bem(
                cpu_ctx, m_xyz, cpu_h_demag, cpu_energy, false, nullptr, error),
            error,
            "CPU FEM/BEM oracle solve");
        fullmag::fem::context_destroy_demag_fem_bem(cpu_ctx);
    }

    int selected_device = 0;
    check(cudaGetDevice(&selected_device) == cudaSuccess,
          "GPU FEM/BEM contract selects CUDA device");
    mfem::Device cuda_device("cuda", selected_device);

    // 1. Explicit CgAmg: AMG coarse relax_type=18, 2 fences / 32 B, parity <= 1e-8.
    run_gpu_fem_bem_case(
        fullmag::fem::GpuDemagSolverStrategy::CgAmg,
        cpu_h_demag,
        cpu_energy,
        false,
        false);

    // 2. Auto with normal VRAM: cuDSS direct pair (or clean unavailable fallback) without receipt bit conflict.
    run_gpu_fem_bem_case(
        fullmag::fem::GpuDemagSolverStrategy::Auto,
        cpu_h_demag,
        cpu_energy,
        false,
        false);

    // 3. Tight 1-byte VRAM cap: Auto falls back atomically to AMG (u1 & u2); explicit Cudss fails hard.
    env_budget.set("1");
    run_gpu_fem_bem_case(
        fullmag::fem::GpuDemagSolverStrategy::Auto,
        cpu_h_demag,
        cpu_energy,
        false,
        true);
    run_gpu_fem_bem_case(
        fullmag::fem::GpuDemagSolverStrategy::Cudss,
        cpu_h_demag,
        cpu_energy,
        true,
        false);
}
#endif

} // namespace

int main() {
    fem_bem_gpu_source_contract();
#if FULLMAG_HAS_CUDA_RUNTIME
    device_bem_apply_is_device_resident();
#endif
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    fem_bem_gpu_runtime_contract();
#endif
    return 0;
}

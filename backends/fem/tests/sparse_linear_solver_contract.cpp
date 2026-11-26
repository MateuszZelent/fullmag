#include "cpu/mfem/common/sparse_linear_solver.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <exception>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#if defined(FULLMAG_FEM_CUDSS_POISSON_ENABLED) && FULLMAG_FEM_CUDSS_POISSON_ENABLED && \
    defined(FULLMAG_HAS_CUDA_RUNTIME) && FULLMAG_HAS_CUDA_RUNTIME
#define FULLMAG_SPARSE_CONTRACT_HAS_CUDSS 1
#include <cuda_runtime.h>
#else
#define FULLMAG_SPARSE_CONTRACT_HAS_CUDSS 0
#endif

namespace {

using fullmag::fem::multiphysics::SparseCpuBackendPolicy;
using fullmag::fem::multiphysics::SparseExecutionTarget;
using fullmag::fem::multiphysics::SparseLinearSolver;
using fullmag::fem::multiphysics::SparseMatrixKind;
using fullmag::fem::multiphysics::SparseSolveConfig;
using fullmag::fem::multiphysics::SparseSolveStats;
using fullmag::fem::multiphysics::assemble_equilibrated_saddle_point_csr;
using fullmag::fem::multiphysics::compute_saddle_point_equilibration_beta;
using fullmag::fem::multiphysics::sparse_independent_relative_residual;

void require(bool condition, const std::string &message)
{
    if (!condition) {
        throw std::runtime_error(message);
    }
}

double vector_rel_error(const mfem::Vector &computed, const mfem::Vector &exact)
{
    require(computed.Size() == exact.Size(), "vector_rel_error size mismatch");
    mfem::Vector diff(computed.Size());
    diff = computed;
    diff -= exact;
    return diff.Norml2() / std::max(1.0, exact.Norml2());
}

mfem::SparseMatrix build_3d_dirichlet_laplacian(int nx, int ny, int nz)
{
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(nx, ny, nz, mfem::Element::TETRAHEDRON);
    mfem::H1_FECollection fec(1, mesh.Dimension());
    mfem::FiniteElementSpace fespace(&mesh, &fec);
    mfem::BilinearForm a(&fespace);
    mfem::ConstantCoefficient one(1.0);
    a.AddDomainIntegrator(new mfem::DiffusionIntegrator(one));
    a.Assemble();

    mfem::Array<int> ess_bdr(mesh.bdr_attributes.Max());
    ess_bdr = 1;
    mfem::Array<int> ess_tdof_list;
    fespace.GetEssentialTrueDofs(ess_bdr, ess_tdof_list);

    mfem::GridFunction x(&fespace);
    x = 0.0;
    mfem::Vector b(fespace.GetTrueVSize());
    b = 0.0;
    mfem::SparseMatrix mat;
    mfem::Vector X, B;
    a.FormLinearSystem(ess_tdof_list, x, b, mat, X, B);
    return mfem::SparseMatrix(mat, true);
}

mfem::SparseMatrix build_coupled_by_nodes_nonsymmetric(
    const mfem::SparseMatrix &scalar_spd,
    int components,
    double precession_strength)
{
    const int n = scalar_spd.Height();
    const int total = components * n;
    mfem::SparseMatrix mat(total, total);
    const int *si = scalar_spd.HostReadI();
    const int *sj = scalar_spd.HostReadJ();
    const double *sa = scalar_spd.HostReadData();

    for (int c = 0; c < components; ++c) {
        const int off = c * n;
        const double diag_scale = 1.0 + 0.15 * static_cast<double>(c);
        for (int i = 0; i < n; ++i) {
            for (int p = si[i]; p < si[i + 1]; ++p) {
                mat.Add(off + i, off + sj[p], diag_scale * sa[p]);
            }
            // Add reaction term so every diagonal block is strictly SPD.
            mat.Add(off + i, off + i, 2.0 + 0.25 * static_cast<double>(c));
        }
    }

    // Add strong skew-symmetric precession coupling between spin components
    // (components 0..2 for 3-comp, or components 1..3 for 4-comp [V, mu_x, mu_y, mu_z]).
    const int spin_base = (components == 4) ? 1 : 0;
    for (int i = 0; i < n; ++i) {
        const double theta = 0.37 * static_cast<double>(i);
        const double mx = std::cos(theta);
        const double my = std::sin(theta) * 0.6;
        const double mz = std::sqrt(std::max(0.0, 1.0 - mx * mx - my * my));
        const double c_j = precession_strength;
        const int ix = (spin_base + 0) * n + i;
        const int iy = (spin_base + 1) * n + i;
        const int iz = (spin_base + 2) * n + i;
        // Skew-symmetric [m]_x block: (0, -mz, my; mz, 0, -mx; -my, mx, 0) * c_j.
        mat.Add(ix, iy, -c_j * mz);
        mat.Add(ix, iz, c_j * my);
        mat.Add(iy, ix, c_j * mz);
        mat.Add(iy, iz, -c_j * mx);
        mat.Add(iz, ix, -c_j * my);
        mat.Add(iz, iy, c_j * mx);

        if (components == 4) {
            // Weakly asymmetric charge-spin reciprocal coupling (SHE/ISHE style).
            const int iv = i;
            mat.Add(iv, ix, 0.2);
            mat.Add(ix, iv, -0.15);
            mat.Add(iv, iy, -0.1);
            mat.Add(iy, iv, 0.12);
        }
    }

    mat.Finalize(0);
    return mat;
}

void spd_factor_once_multi_rhs_all_cpu_backends()
{
    const mfem::SparseMatrix lap = build_3d_dirichlet_laplacian(5, 5, 5);
    const int n = lap.Height();
    constexpr int kNumRhs = 8;

    std::vector<mfem::Vector> exact_solutions(kNumRhs);
    std::vector<mfem::Vector> rhs_vectors(kNumRhs);
    for (int k = 0; k < kNumRhs; ++k) {
        exact_solutions[k].SetSize(n);
        rhs_vectors[k].SetSize(n);
        for (int i = 0; i < n; ++i) {
            exact_solutions[k][i] =
                std::sin(0.13 * static_cast<double>((k + 1) * (i + 1))) +
                0.25 * static_cast<double>(k + 1) / static_cast<double>(n);
        }
        lap.Mult(exact_solutions[k], rhs_vectors[k]);
    }

    std::vector<SparseCpuBackendPolicy> policies = {
        SparseCpuBackendPolicy::Auto,
        SparseCpuBackendPolicy::MfemSerial,
    };
#if defined(FULLMAG_FEM_WITH_SLEPC) && FULLMAG_FEM_WITH_SLEPC && \
    !(defined(FULLMAG_OET0_DISABLE_MPI) && FULLMAG_OET0_DISABLE_MPI)
    policies.push_back(SparseCpuBackendPolicy::PetscMumps);
#endif
#if defined(MFEM_USE_MPI) && !(defined(FULLMAG_OET0_DISABLE_MPI) && FULLMAG_OET0_DISABLE_MPI)
    policies.push_back(SparseCpuBackendPolicy::Hypre);
#endif

    std::vector<mfem::Vector> auto_solutions(kNumRhs);
    for (SparseCpuBackendPolicy policy : policies) {
        SparseSolveConfig cfg{};
        cfg.kind = SparseMatrixKind::Spd;
        cfg.execution_target = SparseExecutionTarget::Cpu;
        cfg.cpu_backend = policy;
        cfg.relative_tolerance = 1.0e-12;
        cfg.maximum_iterations = 4000;

        SparseLinearSolver solver(lap, cfg);
        require(!solver.resolved_solver().empty(), "resolved_solver must be non-empty");
        for (int k = 0; k < kNumRhs; ++k) {
            mfem::Vector sol;
            const SparseSolveStats stats = solver.solve(rhs_vectors[k], sol);
            require(stats.converged, "SPD multi-RHS failed to converge on " + stats.resolved_solver);
            require(stats.independent_relative_residual <= 1.0e-12,
                    "SPD multi-RHS residual too high: " +
                        std::to_string(stats.independent_relative_residual));
            const double direct_res = sparse_independent_relative_residual(lap, sol, rhs_vectors[k]);
            require(std::abs(direct_res - stats.independent_relative_residual) <= 1.0e-14,
                    "independent residual helper mismatch");
            const double err = vector_rel_error(sol, exact_solutions[k]);
            require(err <= 1.0e-11,
                    "SPD multi-RHS exact error too high: " + std::to_string(err));
            if (policy == SparseCpuBackendPolicy::Auto) {
                auto_solutions[k] = sol;
            } else {
                const double parity = vector_rel_error(sol, auto_solutions[k]);
                require(parity <= 1.0e-11,
                        "SPD cross-backend parity mismatch: " + std::to_string(parity));
            }
        }
    }
}

void equilibrated_saddle_point_nanometer_scale()
{
    const int n_a = 48;
    const int n_b = 16;
    const double k_scale = 1.0e14;
    const double b_scale = 1.0e-8;

    mfem::SparseMatrix k_mat(n_a, n_a);
    for (int i = 0; i < n_a; ++i) {
        k_mat.Add(i, i, 4.0 * k_scale);
        if (i + 1 < n_a) {
            k_mat.Add(i, i + 1, -1.0 * k_scale);
            k_mat.Add(i + 1, i, -1.0 * k_scale);
        }
        if (i + 4 < n_a) {
            k_mat.Add(i, i + 4, -0.25 * k_scale);
            k_mat.Add(i + 4, i, -0.25 * k_scale);
        }
    }
    k_mat.Finalize(0);

    // Full-column-rank constraint matrix B (n_a x n_b) at nanometer scale ~1e-8.
    mfem::SparseMatrix b_mat(n_a, n_b);
    for (int j = 0; j < n_b; ++j) {
        const int base = 3 * j;
        b_mat.Add(base, j, 1.0 * b_scale);
        b_mat.Add(base + 1, j, -0.75 * b_scale);
        b_mat.Add(base + 2, j, 0.5 * b_scale);
    }
    b_mat.Finalize(0);

    const double beta = compute_saddle_point_equilibration_beta(k_mat, b_mat);
    require(std::isfinite(beta) && beta > 1.0e18,
            "expected nanometer equilibration beta > 1e18, got " + std::to_string(beta));

    const mfem::SparseMatrix saddle = assemble_equilibrated_saddle_point_csr(k_mat, b_mat, beta);
    require(saddle.Height() == n_a + n_b && saddle.Width() == n_a + n_b,
            "assembled saddle-point matrix dimension mismatch");

    mfem::Vector exact_equil(n_a + n_b);
    for (int i = 0; i < n_a; ++i) {
        exact_equil[i] = std::cos(0.17 * static_cast<double>(i + 1));
    }
    for (int j = 0; j < n_b; ++j) {
        exact_equil[n_a + j] = std::sin(0.29 * static_cast<double>(j + 1));
    }
    mfem::Vector rhs(n_a + n_b);
    saddle.Mult(exact_equil, rhs);

    SparseSolveConfig cfg{};
    cfg.kind = SparseMatrixKind::SymmetricIndefinite;
    cfg.execution_target = SparseExecutionTarget::Cpu;
    cfg.cpu_backend = SparseCpuBackendPolicy::Auto;
    cfg.relative_tolerance = 1.0e-11;
    cfg.maximum_iterations = 4000;

    SparseLinearSolver solver(saddle, cfg);
    mfem::Vector sol;
    const SparseSolveStats stats = solver.solve(rhs, sol);
    require(stats.converged, "equilibrated saddle point failed on " + stats.resolved_solver);
    require(stats.independent_relative_residual <= 1.0e-11,
            "equilibrated saddle point residual too high: " +
                std::to_string(stats.independent_relative_residual));
    const double err = vector_rel_error(sol, exact_equil);
    require(err <= 1.0e-11,
            "equilibrated saddle point solution error too high: " + std::to_string(err));
}

void nonsymmetric_by_nodes_3comp_and_4comp_preconditioned()
{
    const mfem::SparseMatrix scalar_spd = build_3d_dirichlet_laplacian(4, 4, 4);
    for (int components : {3, 4}) {
        const mfem::SparseMatrix mat =
            build_coupled_by_nodes_nonsymmetric(scalar_spd, components, 1.0e3);
        const int n = mat.Height();
        mfem::Vector exact(n);
        for (int i = 0; i < n; ++i) {
            exact[i] = std::sin(0.07 * static_cast<double>(i + 1)) +
                       0.3 * std::cos(0.19 * static_cast<double>(i + 1));
        }
        mfem::Vector rhs(n);
        mat.Mult(exact, rhs);

        std::vector<SparseCpuBackendPolicy> policies = {SparseCpuBackendPolicy::Auto};
#if defined(MFEM_USE_MPI) && !(defined(FULLMAG_OET0_DISABLE_MPI) && FULLMAG_OET0_DISABLE_MPI)
        policies.push_back(SparseCpuBackendPolicy::Hypre);
#endif
        for (SparseCpuBackendPolicy policy : policies) {
            SparseSolveConfig cfg{};
            cfg.kind = SparseMatrixKind::GeneralNonsymmetric;
            cfg.execution_target = SparseExecutionTarget::Cpu;
            cfg.cpu_backend = policy;
            cfg.relative_tolerance = 1.0e-11;
            cfg.maximum_iterations = 2000;
            cfg.gmres_kdim = 100;
            cfg.by_nodes_component_count = components;

            SparseLinearSolver solver(mat, cfg);
            mfem::Vector sol;
            const SparseSolveStats stats = solver.solve(rhs, sol);
            require(stats.converged,
                    "nonsymmetric " + std::to_string(components) +
                        "-comp failed on " + stats.resolved_solver);
            require(stats.independent_relative_residual <= 1.0e-11,
                    "nonsymmetric residual too high: " +
                        std::to_string(stats.independent_relative_residual));
            const double err = vector_rel_error(sol, exact);
            require(err <= 1.0e-10,
                    "nonsymmetric exact error too high: " + std::to_string(err));
        }
    }
}

void concurrent_const_solve_thread_safety()
{
    const mfem::SparseMatrix lap = build_3d_dirichlet_laplacian(4, 4, 4);
    const int n = lap.Height();
    constexpr int kThreads = 4;
    constexpr int kSolvesPerThread = 6;

    std::vector<mfem::Vector> exacts(kSolvesPerThread);
    std::vector<mfem::Vector> rhss(kSolvesPerThread);
    for (int s = 0; s < kSolvesPerThread; ++s) {
        exacts[s].SetSize(n);
        rhss[s].SetSize(n);
        for (int i = 0; i < n; ++i) {
            exacts[s][i] = std::cos(0.11 * static_cast<double>((s + 1) * (i + 1)));
        }
        lap.Mult(exacts[s], rhss[s]);
    }

    for (SparseCpuBackendPolicy policy :
         {SparseCpuBackendPolicy::Auto, SparseCpuBackendPolicy::MfemSerial}) {
        SparseSolveConfig cfg{};
        cfg.kind = SparseMatrixKind::Spd;
        cfg.execution_target = SparseExecutionTarget::Cpu;
        cfg.cpu_backend = policy;
        cfg.relative_tolerance = 1.0e-13;
        cfg.maximum_iterations = 4000;

        const SparseLinearSolver solver(lap, cfg);
        std::vector<mfem::Vector> baseline(kSolvesPerThread);
        for (int s = 0; s < kSolvesPerThread; ++s) {
            const SparseSolveStats stats = solver.solve(rhss[s], baseline[s]);
            require(stats.converged, "concurrent baseline solve failed");
        }

        std::vector<std::exception_ptr> errors(kThreads);
        std::vector<std::thread> workers;
        workers.reserve(kThreads);
        for (int t = 0; t < kThreads; ++t) {
            workers.emplace_back([&, t]() {
                try {
                    for (int s = 0; s < kSolvesPerThread; ++s) {
                        mfem::Vector sol;
                        const SparseSolveStats stats = solver.solve(rhss[s], sol);
                        require(stats.converged, "concurrent solve failed to converge");
                        require(stats.independent_relative_residual <= 1.0e-13,
                                "concurrent solve residual too high");
                        const double diff = vector_rel_error(sol, baseline[s]);
                        require(diff <= 1.0e-14,
                                "concurrent solve diverged from baseline: " + std::to_string(diff));
                    }
                } catch (...) {
                    errors[static_cast<std::size_t>(t)] = std::current_exception();
                }
            });
        }
        for (auto &worker : workers) {
            worker.join();
        }
        for (std::exception_ptr &ep : errors) {
            if (ep) {
                std::rethrow_exception(ep);
            }
        }
    }
}

void gpu_cudss_explicit_parity_and_fail_closed()
{
    const mfem::SparseMatrix lap = build_3d_dirichlet_laplacian(4, 4, 4);
    const int n = lap.Height();
    mfem::Vector exact(n);
    for (int i = 0; i < n; ++i) {
        exact[i] = std::sin(0.21 * static_cast<double>(i + 1));
    }
    mfem::Vector rhs(n);
    lap.Mult(exact, rhs);

    SparseSolveConfig gpu_spd_cfg{};
    gpu_spd_cfg.kind = SparseMatrixKind::Spd;
    gpu_spd_cfg.execution_target = SparseExecutionTarget::GpuCudss;
    gpu_spd_cfg.relative_tolerance = 1.0e-12;

#if FULLMAG_SPARSE_CONTRACT_HAS_CUDSS
    int device_count = 0;
    const cudaError_t count_err = cudaGetDeviceCount(&device_count);
    if (count_err != cudaSuccess || device_count <= 0) {
        bool threw = false;
        try {
            SparseLinearSolver solver(lap, gpu_spd_cfg);
        } catch (const std::runtime_error &) {
            threw = true;
        }
        require(threw, "GpuCudss without visible CUDA device must throw (no silent CPU fallback)");
        return;
    }

    // 1. SPD multi-RHS parity against CPU.
    SparseSolveConfig cpu_spd_cfg = gpu_spd_cfg;
    cpu_spd_cfg.execution_target = SparseExecutionTarget::Cpu;
    SparseLinearSolver cpu_spd(lap, cpu_spd_cfg);
    SparseLinearSolver gpu_spd(lap, gpu_spd_cfg);
    mfem::Vector cpu_sol, gpu_sol;
    require(cpu_spd.solve(rhs, cpu_sol).converged, "CPU SPD solve failed");
    const SparseSolveStats gpu_spd_stats = gpu_spd.solve(rhs, gpu_sol);
    require(gpu_spd_stats.converged, "GPU cuDSS SPD solve failed");
    require(gpu_spd_stats.resolved_solver == "cuda_cudss_spd",
            "unexpected GPU SPD solver label: " + gpu_spd_stats.resolved_solver);
    require(vector_rel_error(gpu_sol, cpu_sol) <= 1.0e-12,
            "GPU cuDSS SPD parity vs CPU exceeded 1e-12");

    // 2. GeneralNonsymmetric parity against CPU.
    const mfem::SparseMatrix nonsym = build_coupled_by_nodes_nonsymmetric(lap, 3, 1.0e2);
    mfem::Vector ns_exact(nonsym.Height());
    for (int i = 0; i < ns_exact.Size(); ++i) {
        ns_exact[i] = std::cos(0.13 * static_cast<double>(i + 1));
    }
    mfem::Vector ns_rhs(nonsym.Height());
    nonsym.Mult(ns_exact, ns_rhs);

    SparseSolveConfig gpu_lu_cfg{};
    gpu_lu_cfg.kind = SparseMatrixKind::GeneralNonsymmetric;
    gpu_lu_cfg.execution_target = SparseExecutionTarget::GpuCudss;
    gpu_lu_cfg.relative_tolerance = 1.0e-12;
    SparseLinearSolver gpu_lu(nonsym, gpu_lu_cfg);
    mfem::Vector gpu_lu_sol;
    const SparseSolveStats gpu_lu_stats = gpu_lu.solve(ns_rhs, gpu_lu_sol);
    require(gpu_lu_stats.converged, "GPU cuDSS LU solve failed");
    require(gpu_lu_stats.resolved_solver == "cuda_cudss_lu",
            "unexpected GPU LU solver label: " + gpu_lu_stats.resolved_solver);
    require(vector_rel_error(gpu_lu_sol, ns_exact) <= 1.0e-12,
            "GPU cuDSS LU exact error exceeded 1e-12");

    // 3. Impossible VRAM cap must fail closed (zero CPU fallback).
    struct ScopedEnvGuard {
        const char *name;
        bool had_old = false;
        std::string old_val;
        ScopedEnvGuard(const char *env_name, const char *new_val) : name(env_name)
        {
            const char *cur = std::getenv(env_name);
            if (cur != nullptr) {
                had_old = true;
                old_val = cur;
            }
            ::setenv(env_name, new_val, 1);
        }
        ~ScopedEnvGuard()
        {
            if (had_old) {
                ::setenv(name, old_val.c_str(), 1);
            } else {
                ::unsetenv(name);
            }
        }
    };
    {
        ScopedEnvGuard budget_cap(
            "FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER_DEVICE_BUDGET_BYTES", "1024");
        bool threw = false;
        try {
            SparseLinearSolver oom_solver(lap, gpu_spd_cfg);
        } catch (const std::runtime_error &) {
            threw = true;
        }
        require(threw, "GpuCudss must fail closed when VRAM cap is 1024 bytes");
    }

    // 4. Singular matrix must fail closed on CUDSS_DATA_INFO != 0 (zero CPU fallback).
    mfem::SparseMatrix singular(4, 4);
    singular.Add(0, 0, 1.0);
    singular.Add(0, 1, 1.0);
    singular.Add(1, 0, 1.0);
    singular.Add(1, 1, 1.0);
    singular.Add(2, 2, 1.0);
    singular.Add(3, 3, 1.0);
    singular.Finalize(0);
    bool singular_threw = false;
    try {
        SparseLinearSolver sing_solver(singular, gpu_lu_cfg);
    } catch (const std::runtime_error &) {
        singular_threw = true;
    }
    require(singular_threw, "GpuCudss must fail closed on singular matrix");
#else
    bool threw = false;
    try {
        SparseLinearSolver solver(lap, gpu_spd_cfg);
    } catch (const std::runtime_error &) {
        threw = true;
    }
    require(threw, "GpuCudss on non-cuDSS build must throw std::runtime_error (no CPU fallback)");
#endif
}

} // namespace

int main()
{
    try {
        spd_factor_once_multi_rhs_all_cpu_backends();
        equilibrated_saddle_point_nanometer_scale();
        nonsymmetric_by_nodes_3comp_and_4comp_preconditioned();
        concurrent_const_solve_thread_safety();
        gpu_cudss_explicit_parity_and_fail_closed();
    } catch (const std::exception &ex) {
        std::cerr << "fem_sparse_linear_solver_contract FAILED: " << ex.what() << "\n";
        return 1;
    }
    std::cout << "fem_sparse_linear_solver_contract PASS\n";
    return 0;
}

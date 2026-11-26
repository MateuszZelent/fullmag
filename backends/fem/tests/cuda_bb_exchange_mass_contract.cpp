#include "context.hpp"
#include "gpu/cuda/reductions/reduction_kernels.hpp"
#include "gpu/cuda/relaxation/bb_exchange_mass.hpp"
#include "gpu/cuda/relaxation/bb_exchange_mass_kernels.hpp"
#include "gpu/cuda/relaxation/pgbb_kernels.hpp"
#include "gpu/cuda/state/device_memory.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"
#include <mfem.hpp>
#include <cuda_runtime.h>
#include <array>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <vector>

namespace {
using namespace fullmag::fem;
void check(bool value, const char *message)
{
    if (!value) { std::fprintf(stderr, "FAIL: %s\n", message); std::exit(1); }
}
void cuda_check(cudaError_t status)
{ check(status == cudaSuccess, cudaGetErrorString(status)); }

void check_tridiagonal_oracle(int n, bool air_row)
{
    mfem::SparseMatrix mass(n), stiffness(n);
    std::vector<long double> md(n), mo(n - 1), kd(n), ko(n - 1);
    const int active = air_row ? n - 1 : n;
    for (int i = 0; i < active; ++i) {
        md[i] = 2.0e-18L * (1.0L + 0.1L * (i % 7));
        mass.Add(i, i, static_cast<double>(md[i]));
        if (i + 1 < active) {
            mo[i] = 0.15e-18L;
            ko[i] = -1.0e-18L * (1.0L + 0.05L * (i % 5));
            mass.Add(i, i + 1, static_cast<double>(mo[i]));
            mass.Add(i + 1, i, static_cast<double>(mo[i]));
            stiffness.Add(i, i + 1, static_cast<double>(ko[i]));
            stiffness.Add(i + 1, i, static_cast<double>(ko[i]));
            kd[i] -= ko[i]; kd[i + 1] -= ko[i];
        }
    }
    for (int i = 0; i < active; ++i) { stiffness.Add(i, i, static_cast<double>(kd[i])); }
    mass.Finalize(); stiffness.Finalize();
    TransferAudit audit{};
    std::shared_ptr<GpuBbExchangeMassWorkspace> workspace;
    std::string error;
    check(gpu_bb_exchange_mass_create(mass, stiffness, workspace, audit, error), error.c_str());
    FemGpuComponentField input{}, output{};
    uint64_t bytes = 0;
    check(gpu_device_allocate_component(input, n, bytes, error), error.c_str());
    check(gpu_device_allocate_component(output, n, bytes, error), error.c_str());
    const std::array<double *, 3> in{input.x, input.y, input.z}, out{output.x, output.y, output.z};
    std::array<std::vector<double>, 3> gradient;
    for (int c = 0; c < 3; ++c) {
        gradient[c].resize(n);
        for (int i = 0; i < n; ++i) {
            gradient[c][i] = c == 2 ? 0.0 : std::sin(0.13 * i + 0.7 * c) + 0.2;
        }
        cuda_check(cudaMemcpy(in[c], gradient[c].data(), n * sizeof(double), cudaMemcpyHostToDevice));
    }
    // Changing lambda must update the device operator without rebuilding or
    // uploading CSR. The oracle is an independent long-double Thomas solve.
    for (double lambda : {1e-12, 1e-8, 1e-6, 1e-3}) {
        const auto before = audit.counters;
        {
            TransferAuditScope hot(audit, TransferAuditScopeKind::HotLoop);
            check(gpu_bb_exchange_mass_solve(*workspace, input, output, lambda,
                nullptr, audit, error), error.c_str());
        }
        check(audit.counters.h2d_bytes == before.h2d_bytes, "warm PCG has zero H2D");
        check(audit.counters.hot_loop_compute_d2h_bytes == before.hot_loop_compute_d2h_bytes,
              "PCG never downloads a vector for CPU work");
        check(audit.counters.hot_loop_control_scalar_host_sync_count ==
                  before.hot_loop_control_scalar_host_sync_count + 1,
              "one terminal certificate read, not a read on every CG iteration");
        check(audit.counters.hot_loop_control_scalar_d2h_bytes ==
                  before.hot_loop_control_scalar_d2h_bytes + sizeof(GpuBbPcgResult),
              "only the terminal PCG certificate crosses D2H");
        check(gpu_bb_exchange_mass_last_relative_residual(*workspace) <= 1e-8,
              "independent true residual certificate");
        const long double weight = 2.0L * std::clamp<long double>(lambda, 1e-12L, 1e-6L) /
            1.25663706212e-6L;
        for (int c = 0; c < 3; ++c) {
            std::vector<long double> d(active), rhs(active), off(active - 1);
            for (int i = 0; i < active; ++i) {
                d[i] = md[i] + weight * kd[i];
                rhs[i] = md[i] * gradient[c][i];
                if (i > 0) { rhs[i] += mo[i - 1] * gradient[c][i - 1]; }
                if (i + 1 < active) {
                    rhs[i] += mo[i] * gradient[c][i + 1];
                    off[i] = mo[i] + weight * ko[i];
                }
            }
            for (int i = 1; i < active; ++i) {
                const long double factor = off[i - 1] / d[i - 1];
                d[i] -= factor * off[i - 1]; rhs[i] -= factor * rhs[i - 1];
            }
            rhs[active - 1] /= d[active - 1];
            for (int i = active - 2; i >= 0; --i) {
                rhs[i] = (rhs[i] - off[i] * rhs[i + 1]) / d[i];
            }
            std::vector<double> actual(n);
            cuda_check(cudaMemcpy(actual.data(), out[c], n * sizeof(double), cudaMemcpyDeviceToHost));
            for (int i = 0; i < active; ++i) {
                check(std::abs(actual[i] - rhs[i]) <= 2e-8L * std::max(1.0L, std::abs(rhs[i])),
                      "device exchange-mass direction matches independent tridiagonal oracle");
            }
            if (air_row) { check(actual.back() == 0.0, "air-only row has zero RHS/direction"); }
        }
    }
    check(!gpu_bb_exchange_mass_solve(*workspace, input, output,
        std::numeric_limits<double>::quiet_NaN(), nullptr, audit, error), "invalid step rejected");
    // A zero field must converge without division by zero, with a true zero certificate.
    cuda_check(cudaMemset(input.x, 0, n * sizeof(double)));
    cuda_check(cudaMemset(input.y, 0, n * sizeof(double)));
    cuda_check(cudaMemset(input.z, 0, n * sizeof(double)));
    check(gpu_bb_exchange_mass_solve(*workspace, input, output, 1e-6, nullptr, audit, error), error.c_str());
    check(gpu_bb_exchange_mass_last_iterations(*workspace) == 0, "zero RHS needs no Krylov steps");
    check(gpu_bb_exchange_mass_last_relative_residual(*workspace) == 0.0, "zero true residual");
    gpu_device_free_component(input); gpu_device_free_component(output);
}

void tangent_and_free_mask()
{
    // Independent projector check, including non-unit m and a frozen node.
    const std::array<double, 9> initial{2, 1, 1, 1, 2, 1, 4, 5, 6};
    const std::array<double, 9> directions{3, 4, 5, -2, 1, 3, 1, 1, 1};
    FemGpuComponentField m{}, z{};
    uint64_t bytes = 0; std::string error;
    check(gpu_device_allocate_component(m, 3, bytes, error), error.c_str());
    check(gpu_device_allocate_component(z, 3, bytes, error), error.c_str());
    std::array<double *, 3> mp{m.x, m.y, m.z}, zp{z.x, z.y, z.z};
    for (int c = 0; c < 3; ++c) {
        std::array<double, 3> a{}, b{};
        for (int i = 0; i < 3; ++i) { a[i] = initial[3 * i + c]; b[i] = directions[3 * i + c]; }
        cuda_check(cudaMemcpy(mp[c], a.data(), sizeof(a), cudaMemcpyHostToDevice));
        cuda_check(cudaMemcpy(zp[c], b.data(), sizeof(b), cudaMemcpyHostToDevice));
    }
    uint8_t *mask = nullptr; const uint8_t host_mask[]{1, 0, 1};
    check(gpu_device_allocate_u8(mask, 3, bytes, error), error.c_str());
    cuda_check(cudaMemcpy(mask, host_mask, sizeof(host_mask), cudaMemcpyHostToDevice));
    fullmag_cuda_relax_project_tangent_field(m.x, m.y, m.z, z.x, z.y, z.z, mask, 3);
    std::array<std::array<double, 3>, 3> result{};
    for (int c = 0; c < 3; ++c) {
        cuda_check(cudaMemcpy(result[c].data(), zp[c], 3 * sizeof(double), cudaMemcpyDeviceToHost));
        check(result[c][1] == 0.0, "free mask zeros frozen direction");
    }
    for (int i : {0, 2}) {
        double dot = 0, scale = 0;
        for (int c = 0; c < 3; ++c) { dot += initial[3 * i + c] * result[c][i]; scale += std::abs(initial[3 * i + c] * result[c][i]); }
        check(std::abs(dot) <= 1e-13 * std::max(1.0, scale), "projected direction is tangent");
    }
    gpu_device_free_component(m); gpu_device_free_component(z); gpu_device_free_u8(mask);
}
void check_planar_extreme_scale_oracle()
{
    // Sub-5 nm SI thin-film scales (h = 3 nm):
    // M_ii ~ 2.2e-20 A m^2, K_ii ~ 4e-20 J, plus an air row (M_ii = 0 -> regularized 1.0).
    // Extreme component disparity: |g_x| ~ 1e5, |g_y| ~ 1e3, |g_z| ~ 1e-130 (and 1e-285) A/m.
    constexpr int n = 129;
    constexpr int active = n - 1;
    mfem::SparseMatrix mass(n), stiffness(n);
    std::vector<long double> md(n, 0.0L), mo(n - 1, 0.0L), kd(n, 0.0L), ko(n - 1, 0.0L);
    for (int i = 0; i < active; ++i) {
        md[i] = 2.2e-20L * (1.0L + 0.07L * (i % 5));
        mass.Add(i, i, static_cast<double>(md[i]));
        if (i + 1 < active) {
            mo[i] = 0.15e-20L;
            ko[i] = -2.0e-20L * (1.0L + 0.04L * (i % 7));
            mass.Add(i, i + 1, static_cast<double>(mo[i]));
            mass.Add(i + 1, i, static_cast<double>(mo[i]));
            stiffness.Add(i, i + 1, static_cast<double>(ko[i]));
            stiffness.Add(i + 1, i, static_cast<double>(ko[i]));
            kd[i] -= ko[i];
            kd[i + 1] -= ko[i];
        }
    }
    for (int i = 0; i < active; ++i) {
        stiffness.Add(i, i, static_cast<double>(kd[i]));
    }
    mass.Finalize();
    stiffness.Finalize();

    TransferAudit audit{};
    std::shared_ptr<GpuBbExchangeMassWorkspace> workspace;
    std::string error;
    check(gpu_bb_exchange_mass_create(mass, stiffness, workspace, audit, error), error.c_str());

    FemGpuComponentField input{}, output{};
    uint64_t bytes = 0;
    check(gpu_device_allocate_component(input, n, bytes, error), error.c_str());
    check(gpu_device_allocate_component(output, n, bytes, error), error.c_str());
    const std::array<double *, 3> in{input.x, input.y, input.z};
    const std::array<double *, 3> out{output.x, output.y, output.z};

    for (const double gz_scale : {1.0e-130, 1.0e-285}) {
        std::array<std::vector<double>, 3> gradient;
        const std::array<double, 3> scales{1.0e5, 1.0e3, gz_scale};
        for (int c = 0; c < 3; ++c) {
            gradient[c].resize(n);
            for (int i = 0; i < n; ++i) {
                gradient[c][i] = scales[c] * (std::sin(0.17 * i + 0.9 * c) + 0.35);
            }
            cuda_check(cudaMemcpy(in[c], gradient[c].data(), n * sizeof(double), cudaMemcpyHostToDevice));
        }
        const double lambda = 1.0e-6;
        check(gpu_bb_exchange_mass_solve(*workspace, input, output, lambda, nullptr, audit, error),
              error.c_str());
        check(gpu_bb_exchange_mass_last_relative_residual(*workspace) <= 1e-8,
              "planar extreme-scale solve must pass independent residual certificate <= 1e-8");

        const long double weight =
            2.0L * std::clamp<long double>(lambda, 1e-12L, 1e-6L) / 1.25663706212e-6L;
        for (int c = 0; c < 3; ++c) {
            std::vector<long double> d(active), rhs(active), off(active - 1);
            for (int i = 0; i < active; ++i) {
                d[i] = md[i] + weight * kd[i];
                rhs[i] = md[i] * static_cast<long double>(gradient[c][i]);
                if (i > 0) { rhs[i] += mo[i - 1] * static_cast<long double>(gradient[c][i - 1]); }
                if (i + 1 < active) {
                    rhs[i] += mo[i] * static_cast<long double>(gradient[c][i + 1]);
                    off[i] = mo[i] + weight * ko[i];
                }
            }
            for (int i = 1; i < active; ++i) {
                const long double factor = off[i - 1] / d[i - 1];
                d[i] -= factor * off[i - 1];
                rhs[i] -= factor * rhs[i - 1];
            }
            rhs[active - 1] /= d[active - 1];
            for (int i = active - 2; i >= 0; --i) {
                rhs[i] = (rhs[i] - off[i] * rhs[i + 1]) / d[i];
            }
            long double component_inf = 0.0L;
            for (int i = 0; i < active; ++i) {
                component_inf = std::max(component_inf, std::abs(rhs[i]));
            }
            check(component_inf > 0.0L, "planar extreme-scale oracle must have nonzero solution");
            std::vector<double> actual(n);
            cuda_check(cudaMemcpy(actual.data(), out[c], n * sizeof(double), cudaMemcpyDeviceToHost));
            for (int i = 0; i < active; ++i) {
                check(std::isfinite(actual[i]), "planar extreme-scale solution must be finite");
                check(std::abs(static_cast<long double>(actual[i]) - rhs[i]) <=
                          2e-8L * std::max(component_inf, std::abs(rhs[i])),
                      "every component including extreme planar z must match Thomas oracle to 2e-8 relative");
            }
            check(actual.back() == 0.0, "air-only row must remain exactly zero");
        }
    }
    gpu_device_free_component(input);
    gpu_device_free_component(output);
}

void check_stiff_fine_mesh_iterations()
{
    // High exchange-to-mass stiffness ratio requiring > 512 Jacobi-PCG iterations
    // and converging cleanly well below the 2048 iteration cap.
    constexpr int n = 1024;
    mfem::SparseMatrix mass(n), stiffness(n);
    std::vector<long double> md(n), kd(n, 0.0L), ko(n - 1, 0.0L);
    for (int i = 0; i < n; ++i) {
        md[i] = 1.0e-20L;
        mass.Add(i, i, static_cast<double>(md[i]));
        if (i + 1 < n) {
            ko[i] = -1.5e-17L;
            stiffness.Add(i, i + 1, static_cast<double>(ko[i]));
            stiffness.Add(i + 1, i, static_cast<double>(ko[i]));
            kd[i] -= ko[i];
            kd[i + 1] -= ko[i];
        }
    }
    for (int i = 0; i < n; ++i) {
        stiffness.Add(i, i, static_cast<double>(kd[i]));
    }
    mass.Finalize();
    stiffness.Finalize();

    TransferAudit audit{};
    std::shared_ptr<GpuBbExchangeMassWorkspace> workspace;
    std::string error;
    check(gpu_bb_exchange_mass_create(mass, stiffness, workspace, audit, error), error.c_str());

    FemGpuComponentField input{}, output{};
    uint64_t bytes = 0;
    check(gpu_device_allocate_component(input, n, bytes, error), error.c_str());
    check(gpu_device_allocate_component(output, n, bytes, error), error.c_str());
    const std::array<double *, 3> in{input.x, input.y, input.z};
    for (int c = 0; c < 3; ++c) {
        std::vector<double> grad(n);
        for (int i = 0; i < n; ++i) {
            const double nyquist = (i % 2 == 0) ? 1.0 : -1.0;
            grad[i] = std::sin(0.0031 * i + 0.4 * c) + 0.7 * nyquist + 0.4 * std::sin(0.37 * i);
        }
        cuda_check(cudaMemcpy(in[c], grad.data(), n * sizeof(double), cudaMemcpyHostToDevice));
    }
    const double lambda = 6.283185307179586e-7; // 2 * lambda / mu0 ~ 1.0 -> w * K_ii / M_ii ~ 3000
    check(gpu_bb_exchange_mass_solve(*workspace, input, output, lambda, nullptr, audit, error),
          error.c_str());
    const uint64_t iterations = gpu_bb_exchange_mass_last_iterations(*workspace);
    check(iterations > 512 && iterations <= 2048,
          "stiff fine mesh must exceed old 512 cap and converge within 2048 iterations");
    check(gpu_bb_exchange_mass_last_relative_residual(*workspace) <= 1e-8,
          "stiff fine mesh must satisfy independent residual certificate <= 1e-8");

    gpu_device_free_component(input);
    gpu_device_free_component(output);
}

void check_auto_policy_resolution()
{
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian1D(4, 1.0e-8);
    mfem::H1_FECollection fec(1, 1);
    mfem::FiniteElementSpace fes(&mesh, &fec);
    mfem::ConstantCoefficient ms_coeff(8.0e5);
    mfem::ConstantCoefficient a_coeff(1.3e-11);
    mfem::BilinearForm mass_form(&fes);
    mass_form.AddDomainIntegrator(new mfem::MassIntegrator(ms_coeff));
    mass_form.Assemble();
    mass_form.Finalize();
    mfem::BilinearForm exchange_form(&fes);
    exchange_form.AddDomainIntegrator(new mfem::DiffusionIntegrator(a_coeff));
    exchange_form.Assemble();
    exchange_form.Finalize();

    Context ctx{};
    ctx.exchange.enabled = true;
    ctx.exchange.mfem.mass_form = &mass_form;
    ctx.exchange.mfem.exchange_form = &exchange_form;
    ctx.gpu_state.device.lifecycle.node_count = static_cast<uint64_t>(fes.GetNDofs());
    ctx.gpu_state.device.relaxation.bb_preconditioner_policy = 0u; // auto

    GpuBbExchangeMassStatus status{};
    gpu_bb_exchange_mass_resolve(ctx, status);
    check(status.requested_policy == 0u, "auto reports requested_policy=0");
    check(status.resolved_enabled, "auto resolves enabled when exchange and forms are ready");
    check(std::strcmp(status.solver_kind, "cooperative_device_pcg") == 0,
          "auto resolved solver_kind is cooperative_device_pcg");
    check(std::strcmp(status.preconditioner_kind, "device_jacobi") == 0,
          "auto resolved preconditioner_kind is device_jacobi");
    check(std::strcmp(status.fallback_reason, "") == 0,
          "auto resolved enabled has empty fallback_reason");
    check(gpu_bb_exchange_mass_enabled(ctx), "gpu_bb_exchange_mass_enabled delegates to resolve");

    ctx.exchange.enabled = false;
    gpu_bb_exchange_mass_resolve(ctx, status);
    check(!status.resolved_enabled, "auto resolves disabled when exchange is disabled");
    check(std::strcmp(status.solver_kind, "not_used") == 0, "disabled solver_kind is not_used");
    check(std::strcmp(status.preconditioner_kind, "not_used") == 0,
          "disabled preconditioner_kind is not_used");
    check(std::strcmp(status.fallback_reason, "exchange_disabled") == 0,
          "auto with exchange disabled reports exchange_disabled");
    check(!gpu_bb_exchange_mass_enabled(ctx), "exchange disabled keeps raw direction");

    ctx.exchange.enabled = true;
    ctx.gpu_state.device.relaxation.bb_preconditioner_policy = 1u; // none
    gpu_bb_exchange_mass_resolve(ctx, status);
    check(status.requested_policy == 1u, "none reports requested_policy=1");
    check(!status.resolved_enabled, "policy=none disables preconditioner");
    check(std::strcmp(status.fallback_reason, "policy_none") == 0,
          "policy=none reports policy_none");
    check(!gpu_bb_exchange_mass_enabled(ctx), "policy=none keeps raw direction");

    ctx.gpu_state.device.relaxation.bb_preconditioner_policy = 2u; // exchange_mass
    ctx.exchange.mfem.mass_form = nullptr;
    gpu_bb_exchange_mass_resolve(ctx, status);
    check(status.requested_policy == 2u, "exchange_mass reports requested_policy=2");
    check(!status.resolved_enabled, "exchange_mass without forms cannot resolve enabled");
    check(std::strcmp(status.fallback_reason, "mfem_forms_unavailable") == 0,
          "missing forms reports mfem_forms_unavailable");
    std::string error;
    check(!gpu_bb_exchange_mass_prepare(ctx, error),
          "explicit exchange_mass without forms fails closed");

    ctx.exchange.mfem.mass_form = nullptr;
    ctx.exchange.mfem.exchange_form = nullptr;
}

void check_solve_and_project_single_sync()
{
    constexpr int n = 64;
    constexpr int blocks = (n + 255) / 256;
    const double kMu0 = 4.0e-7 * std::acos(-1.0);

    mfem::SparseMatrix mass(n), stiffness(n);
    for (int i = 0; i < n - 1; ++i) {
        mass.Add(i, i, 2.0e-20 * (1.0 + 0.05 * (i % 5)));
        if (i + 1 < n - 1) {
            mass.Add(i, i + 1, 0.1e-20);
            mass.Add(i + 1, i, 0.1e-20);
            stiffness.Add(i, i + 1, -1.0e-20);
            stiffness.Add(i + 1, i, -1.0e-20);
            stiffness.Add(i, i, 1.0e-20);
            stiffness.Add(i + 1, i + 1, 1.0e-20);
        }
    }
    mass.Finalize();
    stiffness.Finalize();

    FemGpuComponentField m_backup{}, gradient{};
    double *d_ms = nullptr, *d_lumped_mass = nullptr;
    double *d_scalar_workspace = nullptr, *d_scalar_result = nullptr;
    uint8_t *d_mask = nullptr;
    void *d_temp_storage = nullptr;
    uint64_t bytes = 0;
    std::string error;
    check(gpu_device_allocate_component(m_backup, n, bytes, error), error.c_str());
    check(gpu_device_allocate_component(gradient, n, bytes, error), error.c_str());
    check(gpu_device_allocate_double(d_ms, n, bytes, error), error.c_str());
    check(gpu_device_allocate_double(d_lumped_mass, n, bytes, error), error.c_str());
    check(gpu_device_allocate_u8(d_mask, n, bytes, error), error.c_str());
    check(gpu_device_allocate_double(d_scalar_workspace, blocks, bytes, error), error.c_str());
    check(gpu_device_allocate_double(d_scalar_result, 4, bytes, error), error.c_str());

    size_t temp_bytes = 0;
    fullmag_cuda_device_sum(d_scalar_workspace, blocks, d_scalar_result, nullptr, temp_bytes, nullptr);
    check(temp_bytes > 0, "CUB device sum temp storage query must be positive");
    check(gpu_device_allocate_bytes(&d_temp_storage, temp_bytes, bytes, error), error.c_str());

    std::array<std::vector<double>, 3> h_m, h_g;
    std::vector<double> h_ms(n, 8.0e5), h_mass(n, 2.7e-26);
    std::vector<uint8_t> h_mask(n, 1u);
    h_mask[5] = 0u;     // frozen spin
    h_mask[n - 1] = 0u; // air node
    h_ms[n - 1] = 0.0;
    for (int c = 0; c < 3; ++c) {
        h_m[c].resize(n);
        h_g[c].resize(n);
    }
    for (int i = 0; i < n; ++i) {
        const double theta = 0.23 * i + 0.3;
        const double phi = 0.41 * i + 0.1;
        h_m[0][i] = std::sin(theta) * std::cos(phi);
        h_m[1][i] = std::sin(theta) * std::sin(phi);
        h_m[2][i] = std::cos(theta);
        h_g[0][i] = 1.0e4 * std::cos(0.19 * i + 0.2);
        h_g[1][i] = 1.0e4 * std::sin(0.29 * i + 0.5);
        h_g[2][i] = 1.0e4 * std::cos(0.11 * i - 0.7);
    }
    cuda_check(cudaMemcpy(m_backup.x, h_m[0].data(), n * sizeof(double), cudaMemcpyHostToDevice));
    cuda_check(cudaMemcpy(m_backup.y, h_m[1].data(), n * sizeof(double), cudaMemcpyHostToDevice));
    cuda_check(cudaMemcpy(m_backup.z, h_m[2].data(), n * sizeof(double), cudaMemcpyHostToDevice));
    cuda_check(cudaMemcpy(gradient.x, h_g[0].data(), n * sizeof(double), cudaMemcpyHostToDevice));
    cuda_check(cudaMemcpy(gradient.y, h_g[1].data(), n * sizeof(double), cudaMemcpyHostToDevice));
    cuda_check(cudaMemcpy(gradient.z, h_g[2].data(), n * sizeof(double), cudaMemcpyHostToDevice));
    cuda_check(cudaMemcpy(d_ms, h_ms.data(), n * sizeof(double), cudaMemcpyHostToDevice));
    cuda_check(cudaMemcpy(d_lumped_mass, h_mass.data(), n * sizeof(double), cudaMemcpyHostToDevice));
    cuda_check(cudaMemcpy(d_mask, h_mask.data(), n * sizeof(uint8_t), cudaMemcpyHostToDevice));

    const char *previous_env = std::getenv("FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK");
    const std::string saved_env = previous_env != nullptr ? previous_env : "";
    const bool had_env = previous_env != nullptr;

    for (const bool force_pageable : {false, true}) {
        if (force_pageable) {
            setenv("FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK", "1", 1);
        } else {
            unsetenv("FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK");
        }
        TransferAudit audit{};
        std::shared_ptr<GpuBbExchangeMassWorkspace> workspace;
        check(gpu_bb_exchange_mass_create(mass, stiffness, workspace, audit, error), error.c_str());

        const auto before = audit.counters;
        double dot = 0.0;
        {
            TransferAuditScope hot(audit, TransferAuditScopeKind::HotLoop);
            check(gpu_bb_exchange_mass_solve_and_project(
                      *workspace, m_backup, gradient, d_ms, d_lumped_mass, d_mask,
                      false, nullptr, d_scalar_workspace, d_scalar_result,
                      d_temp_storage, temp_bytes, blocks, 1.0e-6, nullptr,
                      audit, dot, error),
                  error.c_str());
        }
        check(audit.counters.h2d_bytes == before.h2d_bytes,
              "fused solve_and_project has zero hot-loop H2D");
        check(audit.counters.hot_loop_compute_d2h_bytes == before.hot_loop_compute_d2h_bytes,
              "fused solve_and_project has zero hot-loop compute D2H");
        check(audit.counters.hot_loop_control_scalar_host_sync_count ==
                  before.hot_loop_control_scalar_host_sync_count + 1,
              "fused solve_and_project performs exactly one host sync");
        check(audit.counters.hot_loop_control_scalar_d2h_bytes ==
                  before.hot_loop_control_scalar_d2h_bytes +
                      sizeof(GpuBbPcgResult) + sizeof(double),
              "fused solve_and_project transfers exactly certificate plus descent scalar");

        const auto &z = gpu_bb_exchange_mass_direction(*workspace);
        std::array<std::vector<double>, 3> h_z;
        const std::array<double *, 3> zp{z.x, z.y, z.z};
        for (int c = 0; c < 3; ++c) {
            h_z[c].resize(n);
            cuda_check(cudaMemcpy(h_z[c].data(), zp[c], n * sizeof(double), cudaMemcpyDeviceToHost));
            check(h_z[c][5] == 0.0, "frozen node direction is zero after fused projection");
            check(h_z[c][n - 1] == 0.0, "air node direction is zero after fused projection");
        }
        long double ref_dot = 0.0L;
        for (int i = 0; i < n; ++i) {
            if (h_mask[i] == 0u) { continue; }
            const long double w = static_cast<long double>(kMu0) *
                static_cast<long double>(h_ms[i]) * static_cast<long double>(h_mass[i]);
            ref_dot += w * (static_cast<long double>(h_z[0][i]) * h_g[0][i] +
                            static_cast<long double>(h_z[1][i]) * h_g[1][i] +
                            static_cast<long double>(h_z[2][i]) * h_g[2][i]);
        }
        check(std::isfinite(dot), "fused direction dot gradient must be finite");
        check(std::abs(static_cast<long double>(dot) - ref_dot) <=
                  1e-13L * std::max(1.0e-30L, std::abs(ref_dot)),
              "fused direction dot gradient must match host reference to 1e-13");
    }

    if (had_env) {
        setenv("FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK", saved_env.c_str(), 1);
    } else {
        unsetenv("FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK");
    }

    gpu_device_free_component(m_backup);
    gpu_device_free_component(gradient);
    gpu_device_free_double(d_ms);
    gpu_device_free_double(d_lumped_mass);
    gpu_device_free_u8(d_mask);
    gpu_device_free_double(d_scalar_workspace);
    gpu_device_free_double(d_scalar_result);
    gpu_device_free_bytes(d_temp_storage);
}
}

int main()
{
    mfem::Device device("cuda");
    check_auto_policy_resolution();
    check_tridiagonal_oracle(3, true);
    check_tridiagonal_oracle(1031, false);
    check_planar_extreme_scale_oracle();
    check_stiff_fine_mesh_iterations();
    check_solve_and_project_single_sync();
    tangent_and_free_mask();
    std::puts("PASS: cooperative CUDA BB exchange-mass, scaled 3-component oracle, auto policy, and fused single-sync descent");
}

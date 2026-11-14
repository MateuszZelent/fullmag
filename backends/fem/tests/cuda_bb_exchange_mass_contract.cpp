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
}

int main()
{
    mfem::Device device("cuda");
    check_tridiagonal_oracle(3, true);
    check_tridiagonal_oracle(1031, false);
    tangent_and_free_mask();
    std::puts("PASS: cooperative CUDA BB exchange-mass, independent oracle and one terminal D2H");
}

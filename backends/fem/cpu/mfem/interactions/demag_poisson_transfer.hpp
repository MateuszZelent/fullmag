#pragma once

// CPU-only construction helpers. Matrices remain owned by their RHS/recovery
// workspace and never enter GPU runtime state or RK transaction snapshots.
#include "context.hpp"
#include "cpu/mfem/runtime/mfem_device.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>

#include <array>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>

namespace fullmag::fem {

class CpuTransferUnavailable : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

inline int transfer_dof_index(int dof) { return dof >= 0 ? dof : -1 - dof; }
inline double transfer_dof_sign(int dof) { return dof >= 0 ? 1.0 : -1.0; }

struct CpuTransferMemorySample {
    uint64_t rss_bytes = 0;
    uint64_t peak_rss_bytes = 0;
};

inline CpuTransferMemorySample cpu_transfer_parse_memory_status(std::istream &input)
{
    CpuTransferMemorySample sample;
    std::string line;
    while (std::getline(input, line)) {
        if (line.compare(0, 6, "VmRSS:") != 0 && line.compare(0, 6, "VmHWM:") != 0) continue;
        std::istringstream entry(line);
        std::string name, unit;
        uint64_t kib = 0;
        if (!(entry >> name >> kib >> unit) || unit != "kB") continue;
        if (name == "VmRSS:") sample.rss_bytes = kib * 1024u;
        else sample.peak_rss_bytes = kib * 1024u;
    }
    return sample;
}

inline CpuTransferMemorySample cpu_transfer_memory_sample()
{
#if defined(__linux__)
    std::ifstream input("/proc/self/status");
    return cpu_transfer_parse_memory_status(input);
#else
    return {};
#endif
}

inline std::atomic<uint64_t> cpu_transfer_live_matrices{0};

// Defined in the shared native library so the test never reads a separate
// executable-local copy of an inline diagnostic variable across a DSO boundary.
uint64_t cpu_transfer_live_matrix_count_for_tests() noexcept;

class CpuTransferMatrix final : public mfem::SparseMatrix {
public:
    CpuTransferMatrix(int rows, int columns) : mfem::SparseMatrix(rows, columns) {
        cpu_transfer_live_matrices.fetch_add(1, std::memory_order_relaxed);
    }
    ~CpuTransferMatrix() override {
        cpu_transfer_live_matrices.fetch_sub(1, std::memory_order_relaxed);
    }
};

inline void cpu_transfer_observe_peak(Context &ctx, CpuPoissonTransferDiagnostics &diagnostics,
                                      const CpuTransferMemorySample &sample)
{
    if (sample.rss_bytes == 0 || sample.peak_rss_bytes == 0) {
        throw CpuTransferUnavailable("setup RSS/HWM monitoring unavailable");
    }
    const auto &poisson = ctx.poisson_demag;
    diagnostics.setup_rss_baseline_bytes = poisson.cpu_transfer_setup_rss_baseline_bytes;
    diagnostics.setup_observed_peak_rss_bytes = std::max(
        diagnostics.setup_observed_peak_rss_bytes, std::max(sample.rss_bytes, sample.peak_rss_bytes));
    diagnostics.setup_observed_peak_delta_bytes =
        diagnostics.setup_observed_peak_rss_bytes > diagnostics.setup_rss_baseline_bytes
        ? diagnostics.setup_observed_peak_rss_bytes - diagnostics.setup_rss_baseline_bytes : 0;
    // VmHWM retains a transient peak after linked rows or CSR scratch are freed.
    // An older process HWM may conservatively refuse caching; never rebase it.
    if (diagnostics.setup_observed_peak_delta_bytes > poisson.cpu_transfer_setup_limit_bytes) {
        throw CpuTransferUnavailable("setup observed peak RSS budget exceeded");
    }
}

inline uint64_t cpu_transfer_matrix_bytes(const mfem::SparseMatrix &matrix)
{
    return static_cast<uint64_t>(matrix.NumNonZeroElems()) *
        (sizeof(double) + sizeof(int)) +
        (static_cast<uint64_t>(matrix.Height()) + 1u) * sizeof(int);
}

inline void cpu_transfer_check_budget(Context &ctx, CpuPoissonTransferDiagnostics &diagnostics,
                                      uint64_t staged_bytes,
                                      uint64_t scratch_bytes)
{
    const auto &poisson = ctx.poisson_demag;
    cpu_transfer_observe_peak(ctx, diagnostics, cpu_transfer_memory_sample());
    const uint64_t persistent = poisson.rhs_transfer.persistent_bytes +
        poisson.recovery_transfer.persistent_bytes + staged_bytes + scratch_bytes;
    if (persistent > poisson.cpu_transfer_persistent_limit_bytes) {
        throw CpuTransferUnavailable("persistent cache budget exceeded");
    }
}

inline void cpu_transfer_refused(Context &ctx, CpuPoissonTransferDiagnostics &diagnostics,
                                  const char *reason)
{
    diagnostics.state = "quadrature";
    diagnostics.reason = reason;
    if (ctx.poisson_demag.cpu_transfer_setup_rss_baseline_bytes != 0) {
        try {
            cpu_transfer_observe_peak(ctx, diagnostics, cpu_transfer_memory_sample());
        } catch (const CpuTransferUnavailable &peak_refusal) {
            diagnostics.reason = peak_refusal.what();
        }
    }
}

inline void cpu_transfer_begin(Context &ctx, mfem::FiniteElementSpace &state,
                                mfem::FiniteElementSpace &potential,
                                CpuPoissonTransferDiagnostics &diagnostics)
{
    if (mfem_device_requests_gpu(ctx) || ctx.gpu_state.device.lifecycle.allocated) {
        throw CpuTransferUnavailable("CPU transfer cache is disabled for the GPU lane");
    }
    // Retain the existing quadrature operation for unqualified FE transforms.
    // This is an optimization eligibility check, never CPU admission policy.
    if (state.GetVDim() != 1 || potential.GetVDim() != 1 ||
        state.GetMesh() != potential.GetMesh() ||
        state.GetVSize() != state.GetTrueVSize() ||
        potential.GetVSize() != potential.GetTrueVSize()) {
        throw CpuTransferUnavailable("constrained or vector FE space uses quadrature");
    }
    if (ctx.poisson_demag.cpu_transfer_setup_rss_baseline_bytes == 0) {
        ctx.poisson_demag.cpu_transfer_setup_rss_baseline_bytes =
            cpu_transfer_memory_sample().rss_bytes;
    }
    cpu_transfer_check_budget(ctx, diagnostics, 0, 0);
}

inline void cpu_transfer_check_matrix_bound(Context &ctx, CpuPoissonTransferDiagnostics &diagnostics,
                                            uint64_t staged_bytes,
                                            uint64_t scratch_bytes, uint64_t pairs,
                                            int rows)
{
    const uint64_t row_bytes = (static_cast<uint64_t>(rows) + 1u) * sizeof(int);
    if (pairs > ctx.poisson_demag.cpu_transfer_persistent_limit_bytes / 12u ||
        pairs > ctx.poisson_demag.cpu_transfer_setup_limit_bytes / 96u) {
        throw CpuTransferUnavailable("matrix pair bound exceeds cache budget");
    }
    cpu_transfer_check_budget(ctx, diagnostics, staged_bytes + pairs * 12u + row_bytes, scratch_bytes);
    const auto &poisson = ctx.poisson_demag;
    const uint64_t resident = cpu_transfer_memory_sample().rss_bytes;
    const uint64_t growth = resident > poisson.cpu_transfer_setup_rss_baseline_bytes
        ? resident - poisson.cpu_transfer_setup_rss_baseline_bytes : 0;
    // Reserve for MFEM's transient linked rows plus final CSR while Finalize
    // releases the linked representation. Recheck actual RSS during assembly.
    const uint64_t estimate = growth + pairs * 96u + static_cast<uint64_t>(rows) * 64u;
    diagnostics.setup_estimated_peak_delta_bytes = std::max(
        diagnostics.setup_estimated_peak_delta_bytes, estimate);
    if (estimate > poisson.cpu_transfer_setup_limit_bytes) {
        throw CpuTransferUnavailable("matrix construction exceeds setup budget estimate");
    }
}

inline void cpu_transfer_setup_checkpoint(Context &ctx, uint32_t finalized_matrices)
{
    auto &poisson = ctx.poisson_demag;
    if (poisson.cpu_transfer_test_fail_after_finalized_matrices != 0) {
        ++poisson.cpu_transfer_test_finalized_matrices;
        poisson.cpu_transfer_test_peak_live_matrices = std::max(
            poisson.cpu_transfer_test_peak_live_matrices,
            cpu_transfer_live_matrices.load(std::memory_order_relaxed));
        if (finalized_matrices == poisson.cpu_transfer_test_fail_after_finalized_matrices) {
            throw CpuTransferUnavailable("injected setup-only failure after matrix finalization");
        }
    }
}

inline void cpu_transfer_element_dofs(mfem::FiniteElementSpace &space, int element,
                                       mfem::Array<int> &dofs)
{
    if (space.GetElementDofs(element, dofs) != nullptr) {
        throw CpuTransferUnavailable("element DOF transformation uses quadrature");
    }
    for (int dof : dofs) {
        if (transfer_dof_index(dof) < 0 || transfer_dof_index(dof) >= space.GetNDofs()) {
            throw std::runtime_error("CPU transfer element DOF is out of range");
        }
    }
}

inline void cpu_transfer_add(mfem::SparseMatrix &matrix, int row, int column, double value)
{
    if (!std::isfinite(value)) {
        throw std::runtime_error("CPU transfer coefficient is not finite");
    }
    matrix.Add(row, column, value);
}

inline void cpu_transfer_finalize(mfem::SparseMatrix &matrix)
{
    matrix.Finalize();
    const double *values = matrix.GetData();
    for (int entry = 0; entry < matrix.NumNonZeroElems(); ++entry) {
        if (!std::isfinite(values[entry])) {
            throw std::runtime_error("CPU transfer accumulated coefficient is not finite");
        }
    }
}

inline void cpu_transfer_note(const char *kind, const CpuPoissonTransferDiagnostics &diagnostics)
{
    std::fprintf(stderr,
        "[fullmag_fem] cpu fixed coupling: kind=%s state=%s reason=%s "
        "builds=%llu reuses=%llu nnz=%llu persistent_bytes=%llu setup_ns=%llu "
        "rss_baseline=%llu observed_peak_rss=%llu observed_peak_delta=%llu estimated_peak_delta=%llu\n",
        kind, diagnostics.state.c_str(), diagnostics.reason.c_str(),
        static_cast<unsigned long long>(diagnostics.build_count),
        static_cast<unsigned long long>(diagnostics.reuse_count),
        static_cast<unsigned long long>(diagnostics.nnz),
        static_cast<unsigned long long>(diagnostics.persistent_bytes),
        static_cast<unsigned long long>(diagnostics.setup_wall_time_ns),
        static_cast<unsigned long long>(diagnostics.setup_rss_baseline_bytes),
        static_cast<unsigned long long>(diagnostics.setup_observed_peak_rss_bytes),
        static_cast<unsigned long long>(diagnostics.setup_observed_peak_delta_bytes),
        static_cast<unsigned long long>(diagnostics.setup_estimated_peak_delta_bytes));
}

inline void cpu_transfer_reused(const char *kind, CpuPoissonTransferDiagnostics &diagnostics)
{
    ++diagnostics.reuse_count;
    // Bounded progress evidence without logging on every RK stage.
    if ((diagnostics.reuse_count & (diagnostics.reuse_count - 1u)) == 0u) {
        cpu_transfer_note(kind, diagnostics);
    }
}

} // namespace fullmag::fem
#endif

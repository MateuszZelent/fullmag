#include "transfer_audit.hpp"

#include <cstdio>
#include <cstdlib>

static void check(bool condition, const char *msg)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

int main()
{
    fullmag::fem::TransferAudit audit;

    {
        fullmag::fem::TransferAuditScope hot_loop(
            audit,
            fullmag::fem::TransferAuditScopeKind::HotLoop);
        fullmag::fem::record_mfem_host_read(16);

        {
            fullmag::fem::TransferAuditScope exchange(
                audit,
                fullmag::fem::TransferAuditScopeKind::ExchangeInterop);
            fullmag::fem::record_mfem_host_write(24);
            fullmag::fem::record_mfem_host_read_write(32);
        }

        fullmag::fem::record_mfem_host_write(8);
    }

    check(audit.counters.hot_loop_host_sync_count == 4, "total hot-loop sync count mismatch");
    check(audit.counters.hot_loop_compute_host_sync_count == 2, "compute sync count mismatch");
    check(audit.counters.hot_loop_exchange_host_sync_count == 2, "exchange sync count mismatch");
    check(audit.counters.hot_loop_compute_d2h_bytes == 16, "compute D2H byte count mismatch");
    check(audit.counters.hot_loop_compute_h2d_bytes == 8, "compute H2D byte count mismatch");
    check(audit.counters.hot_loop_exchange_d2h_bytes == 32, "exchange D2H byte count mismatch");
    check(audit.counters.hot_loop_exchange_h2d_bytes == 56, "exchange H2D byte count mismatch");

    fullmag::fem::record_mfem_host_read(64);
    check(audit.counters.hot_loop_host_sync_count == 4, "host access outside scope counted as hot-loop");

    fullmag::fem::TransferAudit compute_gate_audit;
    compute_gate_audit.assert_no_hot_loop_compute_sync = true;
    {
        fullmag::fem::TransferAuditScope hot_loop(
            compute_gate_audit,
            fullmag::fem::TransferAuditScopeKind::HotLoop);
        {
            fullmag::fem::TransferAuditScope exchange(
                compute_gate_audit,
                fullmag::fem::TransferAuditScopeKind::ExchangeInterop);
            fullmag::fem::record_mfem_host_write(24);
        }
        check(
            !compute_gate_audit.hot_loop_violation,
            "exchange interop should not violate compute hot-loop gate");

        fullmag::fem::record_mfem_host_read(16);
        check(
            compute_gate_audit.hot_loop_violation,
            "compute host sync should violate compute hot-loop gate");
        check(
            compute_gate_audit.hot_loop_violation_message.find(
                "FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC=1") != std::string::npos,
            "compute hot-loop gate violation message mismatch");
    }

    std::printf("FEM transfer_audit smoke PASS\n");
    return 0;
}

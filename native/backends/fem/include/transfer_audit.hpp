#pragma once

#include "fullmag_fem.h"

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

enum class TransferAuditScopeKind {
    HotLoop,
    ExchangeInterop,
};

struct TransferAudit {
    fullmag_fem_transfer_audit counters{};
    bool assert_no_hot_loop_host_sync = false;
    bool assert_no_hot_loop_compute_sync = false;
    bool hot_loop_violation = false;
    std::string hot_loop_violation_message;
    int hot_loop_depth = 0;
    int exchange_interop_depth = 0;

    void reset_step_violation();
};

/*
 * Runtime owner for transfer-audit state embedded in Context.
 *
 * TransferAudit owns hot-loop counters, assertion gates, nested scope depth,
 * and the latched violation message. Context stores that payload through this
 * runtime owner so transfer-audit storage stays behind the module boundary.
 */
struct TransferAuditRuntimeState {
    mutable TransferAudit audit{};
};

class TransferAuditScope {
public:
    TransferAuditScope(TransferAudit &audit, TransferAuditScopeKind kind);
    ~TransferAuditScope();

    TransferAuditScope(const TransferAuditScope &) = delete;
    TransferAuditScope &operator=(const TransferAuditScope &) = delete;

private:
    TransferAudit *audit_ = nullptr;
    TransferAudit *previous_ = nullptr;
    TransferAuditScopeKind kind_;
};

void record_host_to_device(TransferAudit &audit, uint64_t bytes);
void record_device_to_host(TransferAudit &audit, uint64_t bytes);
void record_mfem_host_read(uint64_t bytes);
void record_mfem_host_write(uint64_t bytes);
void record_mfem_host_read_write(uint64_t bytes);

/*
 * Return the current transfer-audit public counters.
 *
 * TransferAudit owns internal hot-loop scope and violation state; this helper
 * is the read boundary used by C ABI snapshot endpoints that expose only the
 * public counter struct.
 */
fullmag_fem_transfer_audit transfer_audit_snapshot(const TransferAudit &audit);

/*
 * Return the current transfer-audit public counters for a backend Context.
 *
 * Keeps C ABI snapshot entrypoints from reaching into Context storage directly;
 * this module owns the transfer-audit read boundary even when the audit state
 * is embedded in the compatibility Context facade.
 */
fullmag_fem_transfer_audit transfer_audit_snapshot(const Context &ctx);

/*
 * Configure transfer-audit assertion gates from environment.
 *
 * Imports FULLMAG_FEM_ASSERT_NO_HOT_LOOP_HOST_SYNC and
 * FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC into the audit state used by
 * native FEM hot-loop scopes. The C ABI layer owns backend allocation, but this
 * module owns how transfer-audit environment policy maps onto audit flags.
 */
void configure_transfer_audit_from_env(TransferAudit &audit);

} // namespace fullmag::fem

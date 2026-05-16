#pragma once

#include "fullmag_fem.h"

#include <cstdint>
#include <string>

namespace fullmag::fem {

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

} // namespace fullmag::fem

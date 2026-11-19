/*
 * GPU CUDA transfer-audit source contract.
 *
 * This source owns transfer-audit env gate import, scope tracking, host-sync
 * counters, violation latching, and public counter snapshots for native FEM
 * runtime diagnostics. It does not own C ABI calls, Context construction, MFEM device policy, interaction physics, or integrator execution.
 */

#include "gpu/cuda/transfer/transfer_audit.hpp"

#include "context.hpp"

#include <cctype>
#include <cstdlib>
#include <sstream>
#include <string>

namespace fullmag::fem {

namespace {

thread_local TransferAudit *current_audit = nullptr;

bool env_flag(const char *name)
{
    const char *raw = std::getenv(name);
    if (raw == nullptr) {
        return false;
    }
    std::string value(raw);
    for (char &ch : value) {
        ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    }
    return value == "1" || value == "on" || value == "true" || value == "yes";
}

void mark_violation(
    TransferAudit &audit,
    const char *operation,
    bool exchange_interop)
{
    if (audit.hot_loop_depth <= 0) {
        return;
    }

    const bool host_gate_violation = audit.assert_no_hot_loop_host_sync;
    const bool compute_gate_violation =
        audit.assert_no_hot_loop_compute_sync && !exchange_interop;
    if (!host_gate_violation && !compute_gate_violation) {
        return;
    }

    audit.hot_loop_violation = true;
    if (!audit.hot_loop_violation_message.empty()) {
        return;
    }

    std::ostringstream message;
    if (compute_gate_violation && !host_gate_violation) {
        message << "FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC=1 caught "
                << operation << " during FEM compute hot loop";
    } else {
        message << "FULLMAG_FEM_ASSERT_NO_HOT_LOOP_HOST_SYNC=1 caught "
                << operation << " during FEM hot loop";
    }
    audit.hot_loop_violation_message = message.str();
}

void record_host_read(TransferAudit &audit, uint64_t bytes)
{
    audit.counters.d2h_bytes += bytes;
    audit.counters.host_read_count += 1;
    if (audit.hot_loop_depth > 0) {
        audit.counters.hot_loop_d2h_bytes += bytes;
        audit.counters.hot_loop_host_read_count += 1;
        audit.counters.hot_loop_host_sync_count += 1;
        const bool exchange_interop = audit.exchange_interop_depth > 0;
        if (exchange_interop) {
            audit.counters.hot_loop_exchange_d2h_bytes += bytes;
            audit.counters.hot_loop_exchange_host_sync_count += 1;
        } else {
            audit.counters.hot_loop_compute_d2h_bytes += bytes;
            audit.counters.hot_loop_compute_host_sync_count += 1;
        }
        mark_violation(audit, "HostRead/D2H", exchange_interop);
    }
}

void record_control_scalar_read(TransferAudit &audit, uint64_t bytes)
{
    audit.counters.d2h_bytes += bytes;
    audit.counters.host_read_count += 1;
    if (audit.hot_loop_depth > 0) {
        audit.counters.hot_loop_d2h_bytes += bytes;
        audit.counters.hot_loop_host_read_count += 1;
        audit.counters.hot_loop_host_sync_count += 1;
        audit.counters.hot_loop_control_scalar_d2h_bytes += bytes;
        audit.counters.hot_loop_control_scalar_host_sync_count += 1;
    }
}

void record_host_write(TransferAudit &audit, uint64_t bytes)
{
    audit.counters.h2d_bytes += bytes;
    audit.counters.host_write_count += 1;
    if (audit.hot_loop_depth > 0) {
        audit.counters.hot_loop_h2d_bytes += bytes;
        audit.counters.hot_loop_host_write_count += 1;
        audit.counters.hot_loop_host_sync_count += 1;
        const bool exchange_interop = audit.exchange_interop_depth > 0;
        if (exchange_interop) {
            audit.counters.hot_loop_exchange_h2d_bytes += bytes;
            audit.counters.hot_loop_exchange_host_sync_count += 1;
        } else {
            audit.counters.hot_loop_compute_h2d_bytes += bytes;
            audit.counters.hot_loop_compute_host_sync_count += 1;
        }
        mark_violation(audit, "HostWrite/H2D", exchange_interop);
    }
}

void record_host_read_write(TransferAudit &audit, uint64_t bytes)
{
    audit.counters.d2h_bytes += bytes;
    audit.counters.h2d_bytes += bytes;
    audit.counters.host_read_write_count += 1;
    if (audit.hot_loop_depth > 0) {
        audit.counters.hot_loop_d2h_bytes += bytes;
        audit.counters.hot_loop_h2d_bytes += bytes;
        audit.counters.hot_loop_host_read_write_count += 1;
        audit.counters.hot_loop_host_sync_count += 1;
        const bool exchange_interop = audit.exchange_interop_depth > 0;
        if (exchange_interop) {
            audit.counters.hot_loop_exchange_d2h_bytes += bytes;
            audit.counters.hot_loop_exchange_h2d_bytes += bytes;
            audit.counters.hot_loop_exchange_host_sync_count += 1;
        } else {
            audit.counters.hot_loop_compute_d2h_bytes += bytes;
            audit.counters.hot_loop_compute_h2d_bytes += bytes;
            audit.counters.hot_loop_compute_host_sync_count += 1;
        }
        mark_violation(audit, "HostReadWrite/D2H+H2D", exchange_interop);
    }
}

} // namespace

void TransferAudit::reset_step_violation()
{
    hot_loop_violation = false;
    hot_loop_violation_message.clear();
}

TransferAuditScope::TransferAuditScope(
    TransferAudit &audit,
    TransferAuditScopeKind kind)
    : audit_(&audit)
    , previous_(current_audit)
    , kind_(kind)
{
    current_audit = audit_;
    if (kind_ == TransferAuditScopeKind::HotLoop) {
        audit_->hot_loop_depth += 1;
    } else if (kind_ == TransferAuditScopeKind::ExchangeInterop) {
        audit_->exchange_interop_depth += 1;
    }
}

TransferAuditScope::~TransferAuditScope()
{
    if (audit_ != nullptr && kind_ == TransferAuditScopeKind::HotLoop) {
        audit_->hot_loop_depth -= 1;
        if (audit_->hot_loop_depth < 0) {
            audit_->hot_loop_depth = 0;
        }
    } else if (audit_ != nullptr && kind_ == TransferAuditScopeKind::ExchangeInterop) {
        audit_->exchange_interop_depth -= 1;
        if (audit_->exchange_interop_depth < 0) {
            audit_->exchange_interop_depth = 0;
        }
    }
    current_audit = previous_;
}

void record_host_to_device(TransferAudit &audit, uint64_t bytes)
{
    record_host_write(audit, bytes);
}

void record_device_to_host(TransferAudit &audit, uint64_t bytes)
{
    record_host_read(audit, bytes);
}

void record_device_control_scalar_to_host(TransferAudit &audit, uint64_t bytes)
{
    record_control_scalar_read(audit, bytes);
}

void record_mfem_host_read(uint64_t bytes)
{
    if (current_audit != nullptr) {
        record_host_read(*current_audit, bytes);
    }
}

void record_mfem_host_write(uint64_t bytes)
{
    if (current_audit != nullptr) {
        record_host_write(*current_audit, bytes);
    }
}

void record_mfem_host_read_write(uint64_t bytes)
{
    if (current_audit != nullptr) {
        record_host_read_write(*current_audit, bytes);
    }
}

fullmag_fem_transfer_audit transfer_audit_snapshot(const TransferAudit &audit)
{
    return audit.counters;
}

fullmag_fem_transfer_audit transfer_audit_snapshot(const Context &ctx)
{
    return transfer_audit_snapshot(ctx.transfer_audit.audit);
}

void configure_transfer_audit_from_env(TransferAudit &audit)
{
    audit.assert_no_hot_loop_host_sync =
        env_flag("FULLMAG_FEM_ASSERT_NO_HOT_LOOP_HOST_SYNC");
    audit.assert_no_hot_loop_compute_sync =
        env_flag("FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC");
}

} // namespace fullmag::fem

/*
 * Direct CPU/MFEM exchange-energy difference.
 *
 * For the symmetric assembled exchange form K_A and the production energy
 * convention E_ex(m) = m^T K_A m, polarization gives
 *
 *   E_ex(trial) - E_ex(base) = (trial - base)^T K_A (trial + base).
 *
 * This avoids subtracting two nearly equal endpoint energies and deliberately
 * does not derive the identity from the mass-projected exchange field.
 */
#include "cpu/mfem/interactions/exchange_energy_difference.hpp"

#include "context.hpp"
#include "cpu/mfem/runtime/interrupt.hpp"
#include "cpu/mfem/runtime/mfem_host_access.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#include <cmath>
#include <limits>
#include <string>
#include <vector>

namespace fullmag::fem {
namespace {

relaxation::EnergyDifference invalid_exchange_difference()
{
    const double invalid = std::numeric_limits<double>::quiet_NaN();
    return {invalid, invalid, invalid};
}

bool all_finite(const std::vector<double> &values)
{
    for (double value : values) {
        if (!std::isfinite(value)) {
            return false;
        }
    }
    return true;
}

} // namespace

relaxation::EnergyDifference polarized_exchange_difference_from_applied_sum(
    const double *difference,
    const double *applied_sum,
    std::size_t scalar_count)
{
    if (difference == nullptr || applied_sum == nullptr || scalar_count == 0u) {
        return invalid_exchange_difference();
    }
    relaxation::EnergyDifference result;
    for (std::size_t index = 0; index < scalar_count; ++index) {
        const double term = difference[index] * applied_sum[index];
        if (!std::isfinite(difference[index]) || !std::isfinite(applied_sum[index]) ||
            !std::isfinite(term)) {
            return invalid_exchange_difference();
        }
        result.delta_joules += term;
        result.absolute_term_sum_joules += std::abs(term);
    }
    result.roundoff_bound_joules =
        relaxation::reduction_roundoff_bound(scalar_count) *
        result.absolute_term_sum_joules;
    if (!std::isfinite(result.delta_joules) ||
        !std::isfinite(result.absolute_term_sum_joules) ||
        !std::isfinite(result.roundoff_bound_joules)) {
        return invalid_exchange_difference();
    }
    return result;
}

relaxation::EnergyDifference exchange_energy_difference(
    Context &ctx,
    const std::vector<double> &base_m_xyz,
    const std::vector<double> &trial_m_xyz,
    bool allow_interrupt,
    std::string &error)
{
    error.clear();
    if (base_m_xyz.empty() || base_m_xyz.size() % 3u != 0u ||
        trial_m_xyz.size() != base_m_xyz.size() ||
        ctx.mesh.n_nodes > std::numeric_limits<std::size_t>::max() / 3u ||
        base_m_xyz.size() != 3u * ctx.mesh.n_nodes) {
        error = "CPU/MFEM polarized exchange difference magnetization size mismatch";
        return invalid_exchange_difference();
    }
    if (!all_finite(base_m_xyz) || !all_finite(trial_m_xyz)) {
        error = "CPU/MFEM polarized exchange difference contains non-finite magnetization";
        return invalid_exchange_difference();
    }
    if (!ctx.exchange.enabled) {
        return {};
    }

#if FULLMAG_HAS_MFEM_STACK
    if (!ctx.mfem_context.ready) {
        error = "CPU/MFEM polarized exchange difference requested before MFEM initialization";
        return invalid_exchange_difference();
    }
    if (ctx.mesh.n_nodes > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
        error = "CPU/MFEM polarized exchange difference exceeds MFEM vector capacity";
        return invalid_exchange_difference();
    }
    auto *exchange_form =
        static_cast<mfem::BilinearForm *>(ctx.exchange.mfem.exchange_form);
    const int node_count = static_cast<int>(ctx.mesh.n_nodes);
    if (exchange_form == nullptr || exchange_form->FESpace() == nullptr ||
        exchange_form->FESpace()->GetNDofs() != node_count ||
        exchange_form->Height() != node_count || exchange_form->Width() != node_count) {
        error = "CPU/MFEM polarized exchange difference assembled form is unavailable or has incompatible dimensions";
        return invalid_exchange_difference();
    }

    TransferAuditScope exchange_audit_scope(
        ctx.transfer_audit.audit,
        TransferAuditScopeKind::ExchangeInterop);
    const bool use_device = mfem::Device::IsEnabled();
    mfem::Vector difference(node_count);
    mfem::Vector sum(node_count);
    mfem::Vector applied(node_count);
    difference.UseDevice(use_device);
    sum.UseDevice(use_device);
    applied.UseDevice(use_device);

    relaxation::EnergyDifference result;
    for (std::size_t component = 0; component < 3u; ++component) {
        double *difference_host = audited_host_write(difference);
        double *sum_host = audited_host_write(sum);
        for (std::size_t node = 0; node < ctx.mesh.n_nodes; ++node) {
            const std::size_t index = 3u * node + component;
            const double difference_value =
                trial_m_xyz[index] - base_m_xyz[index];
            const double sum_value = trial_m_xyz[index] + base_m_xyz[index];
            if (!std::isfinite(difference_value) || !std::isfinite(sum_value)) {
                error = "CPU/MFEM polarized exchange difference produced a non-finite polarized vector";
                return invalid_exchange_difference();
            }
            difference_host[node] = difference_value;
            sum_host[node] = sum_value;
        }
        exchange_form->Mult(sum, applied);
        if (allow_interrupt && poll_interrupt(ctx)) {
            error = "CPU/MFEM polarized exchange difference interrupted";
            return invalid_exchange_difference();
        }
        const auto component_difference =
            polarized_exchange_difference_from_applied_sum(
                audited_host_read(difference),
                audited_host_read(applied),
                ctx.mesh.n_nodes);
        if (!std::isfinite(component_difference.delta_joules) ||
            !std::isfinite(component_difference.absolute_term_sum_joules) ||
            !std::isfinite(component_difference.roundoff_bound_joules)) {
            error = "CPU/MFEM polarized exchange difference accumulation is non-finite";
            return invalid_exchange_difference();
        }
        result.delta_joules += component_difference.delta_joules;
        result.absolute_term_sum_joules +=
            component_difference.absolute_term_sum_joules;
    }
    result.roundoff_bound_joules =
        relaxation::reduction_roundoff_bound(3u * ctx.mesh.n_nodes) *
        result.absolute_term_sum_joules;
    if (!std::isfinite(result.delta_joules) ||
        !std::isfinite(result.absolute_term_sum_joules) ||
        !std::isfinite(result.roundoff_bound_joules)) {
        error = "CPU/MFEM polarized exchange difference result is non-finite";
        return invalid_exchange_difference();
    }
    return result;
#else
    (void)allow_interrupt;
    error = "CPU/MFEM polarized exchange difference requires FULLMAG_USE_MFEM_STACK=ON";
    return invalid_exchange_difference();
#endif
}

} // namespace fullmag::fem

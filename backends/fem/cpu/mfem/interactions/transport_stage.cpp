#include "cpu/mfem/interactions/transport_stage.hpp"

#include "context.hpp"
#include "cpu/mfem/runtime/mfem_device.hpp"

#include <algorithm>
#include <cmath>
#include <sstream>

namespace fullmag::fem {

namespace {

void copy_callback_error(
    std::string &error,
    const char *buffer,
    uint64_t capacity,
    const char *fallback)
{
    if (buffer != nullptr && capacity > 0u && buffer[0] != '\0') {
        error = buffer;
    } else {
        error = fallback;
    }
}

bool callback_layout_is_valid(
    const fullmag_fem_stage_transport_callback_v1 &callback,
    std::string &error)
{
    if (callback.abi_version != FULLMAG_FEM_STAGE_TRANSPORT_CALLBACK_ABI_VERSION) {
        error = "stage transport callback ABI version is unsupported";
        return false;
    }
    if (callback.struct_size < sizeof(fullmag_fem_stage_transport_callback_v1)) {
        error = "stage transport callback struct_size is smaller than v1";
        return false;
    }
    if (callback.evaluate == nullptr) {
        error = "stage transport callback requires an evaluate function";
        return false;
    }
    return true;
}

bool invoke_attempt_callback(
    const fullmag_fem_stage_transport_callback_v1 &callback,
    fullmag_fem_stage_transport_attempt_fn function,
    uint64_t target_step,
    uint64_t attempt_identity,
    double time_start_s,
    double dt_seconds,
    std::string &error,
    const char *operation)
{
    if (function == nullptr) {
        return true;
    }
    char callback_error[FULLMAG_FEM_STAGE_TRANSPORT_CALLBACK_ERROR_CAPACITY]{};
    const int status = function(
        callback.user_data,
        target_step,
        attempt_identity,
        time_start_s,
        dt_seconds,
        callback_error,
        sizeof(callback_error));
    if (status == 0) {
        return true;
    }
    std::ostringstream message;
    message << "stage transport callback " << operation << " failed";
    if (callback_error[0] != '\0') {
        message << ": " << callback_error;
    }
    error = message.str();
    return false;
}

} // namespace

bool materialize_transport_stage_rhs(
    Context &ctx,
    const std::vector<double> &m_xyz,
    double evaluation_time_s,
    uint64_t stage_identity,
    std::string &error)
{
    if (!ctx.stage_transport.has_stage_callback) {
        ctx.stage_transport.torque_xyz_per_s.assign(m_xyz.size(), 0.0);
        return true;
    }
    if (mfem_device_requests_gpu(ctx)) {
        error = "stage transport callback is CPU-only until its device-resident lane is qualified";
        return false;
    }
    if (m_xyz.empty() || m_xyz.size() % 3u != 0u ||
        !std::all_of(m_xyz.begin(), m_xyz.end(), [](double value) { return std::isfinite(value); })) {
        error = "stage transport callback received an invalid magnetization";
        return false;
    }
    if (!std::isfinite(evaluation_time_s)) {
        error = "stage transport evaluation time is non-finite";
        return false;
    }
    const auto &callback = ctx.stage_transport.stage_callback;
    ctx.stage_transport.torque_xyz_per_s.assign(m_xyz.size(), 0.0);
    uint64_t source_state_revision = 0;
    char callback_error[FULLMAG_FEM_STAGE_TRANSPORT_CALLBACK_ERROR_CAPACITY]{};
    const int status = callback.evaluate(
        callback.user_data,
        m_xyz.data(),
        static_cast<uint64_t>(m_xyz.size()),
        evaluation_time_s,
        stage_identity,
        ctx.stage_transport.torque_xyz_per_s.data(),
        static_cast<uint64_t>(ctx.stage_transport.torque_xyz_per_s.size()),
        &source_state_revision,
        callback_error,
        sizeof(callback_error));
    if (status != 0) {
        copy_callback_error(
            error,
            callback_error,
            sizeof(callback_error),
            "stage transport callback evaluate failed");
        ctx.stage_transport.torque_xyz_per_s.clear();
        return false;
    }
    if (!std::all_of(
            ctx.stage_transport.torque_xyz_per_s.begin(),
            ctx.stage_transport.torque_xyz_per_s.end(),
            [](double value) { return std::isfinite(value); })) {
        error = "stage transport callback returned a non-finite torque";
        ctx.stage_transport.torque_xyz_per_s.clear();
        return false;
    }
    ctx.stage_transport.stage_identity = stage_identity;
    ctx.stage_transport.stage_source_state_revision = source_state_revision;
    return true;
}

void add_transport_stage_rhs(
    const Context &ctx,
    std::vector<double> &rhs_xyz,
    double &max_rhs)
{
    const size_t count = std::min(rhs_xyz.size(), ctx.stage_transport.torque_xyz_per_s.size());
    for (size_t index = 0; index < count; ++index) {
        rhs_xyz[index] += ctx.stage_transport.torque_xyz_per_s[index];
        max_rhs = std::max(max_rhs, std::abs(rhs_xyz[index]));
    }
}

bool begin_transport_stage_attempt(
    Context &ctx,
    uint64_t target_step,
    uint64_t attempt_identity,
    double time_start_s,
    double dt_seconds,
    std::string &error)
{
    if (!ctx.stage_transport.has_stage_callback) {
        return true;
    }
    if (ctx.stage_transport.stage_attempt_active) {
        error = "stage transport callback attempt is already active";
        return false;
    }
    if (!std::isfinite(time_start_s) || !std::isfinite(dt_seconds) || dt_seconds <= 0.0) {
        error = "stage transport attempt carries invalid time or dt";
        return false;
    }
    if (!invoke_attempt_callback(
            ctx.stage_transport.stage_callback,
            ctx.stage_transport.stage_callback.begin_attempt,
            target_step,
            attempt_identity,
            time_start_s,
            dt_seconds,
            error,
            "begin_attempt")) {
        return false;
    }
    ctx.stage_transport.stage_attempt_active = true;
    ctx.stage_transport.stage_attempt_target_step = target_step;
    ctx.stage_transport.stage_attempt_identity = attempt_identity;
    ctx.stage_transport.stage_attempt_time_start_s = time_start_s;
    ctx.stage_transport.stage_attempt_dt_seconds = dt_seconds;
    return true;
}

bool commit_transport_stage_attempt(Context &ctx, std::string &error)
{
    if (!ctx.stage_transport.has_stage_callback || !ctx.stage_transport.stage_attempt_active) {
        return true;
    }
    const bool ok = invoke_attempt_callback(
        ctx.stage_transport.stage_callback,
        ctx.stage_transport.stage_callback.commit_attempt,
        ctx.stage_transport.stage_attempt_target_step,
        ctx.stage_transport.stage_attempt_identity,
        ctx.stage_transport.stage_attempt_time_start_s,
        ctx.stage_transport.stage_attempt_dt_seconds,
        error,
        "commit_attempt");
    if (ok) {
        ctx.stage_transport.stage_attempt_active = false;
        ctx.stage_transport.stage_attempt_target_step = 0;
        ctx.stage_transport.stage_attempt_identity = 0;
        ctx.stage_transport.stage_attempt_time_start_s = 0.0;
        ctx.stage_transport.stage_attempt_dt_seconds = 0.0;
    }
    return ok;
}

bool rollback_transport_stage_attempt(Context &ctx, std::string &error)
{
    if (!ctx.stage_transport.has_stage_callback || !ctx.stage_transport.stage_attempt_active) {
        return true;
    }
    const bool ok = invoke_attempt_callback(
        ctx.stage_transport.stage_callback,
        ctx.stage_transport.stage_callback.rollback_attempt,
        ctx.stage_transport.stage_attempt_target_step,
        ctx.stage_transport.stage_attempt_identity,
        ctx.stage_transport.stage_attempt_time_start_s,
        ctx.stage_transport.stage_attempt_dt_seconds,
        error,
        "rollback_attempt");
    ctx.stage_transport.stage_attempt_active = false;
    ctx.stage_transport.stage_attempt_target_step = 0;
    ctx.stage_transport.stage_attempt_identity = 0;
    ctx.stage_transport.stage_attempt_time_start_s = 0.0;
    ctx.stage_transport.stage_attempt_dt_seconds = 0.0;
    return ok;
}

bool configure_transport_stage_callback(
    Context &ctx,
    const fullmag_fem_stage_transport_callback_v1 *callback,
    std::string &error)
{
    if (callback == nullptr) {
        ctx.stage_transport.has_stage_callback = false;
        ctx.stage_transport.stage_callback = {};
        ctx.stage_transport.torque_xyz_per_s.clear();
        ctx.stage_transport.stage_attempt_active = false;
        ctx.stage_transport.stage_attempt_target_step = 0;
        ctx.stage_transport.stage_attempt_identity = 0;
        ctx.stage_transport.stage_attempt_time_start_s = 0.0;
        ctx.stage_transport.stage_attempt_dt_seconds = 0.0;
        ctx.stage_transport.stage_identity = 0;
        ctx.stage_transport.stage_source_state_revision = 0;
        ctx.stepper.workspace.fsal_valid = false;
        return true;
    }
    if (!callback_layout_is_valid(*callback, error)) {
        return false;
    }
    if (ctx.stage_transport.stage_attempt_active) {
        error = "cannot replace a stage transport callback during an active attempt";
        return false;
    }
    ctx.stage_transport.stage_callback = *callback;
    ctx.stage_transport.has_stage_callback = true;
    ctx.stage_transport.stage_identity = 0;
    ctx.stage_transport.stage_source_state_revision = 0;
    ctx.stepper.workspace.fsal_valid = false;
    return true;
}

} // namespace fullmag::fem

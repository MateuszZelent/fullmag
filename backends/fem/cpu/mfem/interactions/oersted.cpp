/*
 * Oersted aggregate source contract.
 *
 * This compatibility source owns plan import, realization exclusivity, and
 * dispatch between analytical-cylinder and explicit nodal Oersted paths.
 * It does not sample analytical cylinders or add explicit nodal fields.
 */
#include "cpu/mfem/interactions/oersted.hpp"

#include "context.hpp"

#include <algorithm>
#include <cmath>
#include <sstream>

namespace fullmag::fem {

bool initialize_oersted_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error)
{
    const uint64_t expected_field_len = static_cast<uint64_t>(ctx.mesh.n_nodes) * 3ull;
    if (plan.oersted_field_xyz != nullptr &&
        plan.oersted_field_len != expected_field_len) {
        error = "oersted_field_xyz length mismatch";
        return false;
    }
    if (plan.has_oersted_cylinder != 0 &&
        plan.oersted_field_xyz != nullptr &&
        plan.oersted_field_len > 0) {
        error = "oersted cylinder and explicit oersted_field_xyz are mutually exclusive";
        return false;
    }

    ctx.oersted.has_cylinder = plan.has_oersted_cylinder != 0;
    ctx.oersted.has_explicit_field = plan.oersted_field_xyz != nullptr && plan.oersted_field_len > 0;
    ctx.oersted.current = plan.oersted_current;
    ctx.oersted.radius = plan.oersted_radius;
    for (int i = 0; i < 3; ++i) {
        ctx.oersted.center[i] = plan.oersted_center[i];
        ctx.oersted.axis[i] = plan.oersted_axis[i];
    }
    if (!normalize_oersted_cylinder_axis(ctx, error)) {
        return false;
    }
    ctx.oersted.time_dep_kind = plan.oersted_time_dep_kind;
    ctx.oersted.time_dep_freq = plan.oersted_time_dep_freq;
    ctx.oersted.time_dep_phase = plan.oersted_time_dep_phase;
    ctx.oersted.time_dep_offset = plan.oersted_time_dep_offset;
    ctx.oersted.time_dep_t_on = plan.oersted_time_dep_t_on;
    ctx.oersted.time_dep_t_off = plan.oersted_time_dep_t_off;

    if (ctx.oersted.has_explicit_field) {
        ctx.oersted.h_xyz.assign(
            plan.oersted_field_xyz,
            plan.oersted_field_xyz + static_cast<size_t>(plan.oersted_field_len));
        ctx.oersted.h_basis_per_ampere_xyz.clear();
        return true;
    }
    if (!initialize_oersted_cylinder_field(ctx, error)) {
        return false;
    }
    materialize_oersted_field(ctx, ctx.state.current_time);
    return true;
}

const std::vector<double> &materialize_oersted_field(
    Context &ctx,
    double evaluation_time_s)
{
    if (!ctx.oersted.has_cylinder) {
        return ctx.oersted.h_xyz;
    }
    const double scale = oersted_current_scale(ctx, evaluation_time_s);
    ctx.oersted.h_xyz.resize(ctx.oersted.h_basis_per_ampere_xyz.size());
    for (size_t i = 0; i < ctx.oersted.h_xyz.size(); ++i) {
        ctx.oersted.h_xyz[i] = scale * ctx.oersted.h_basis_per_ampere_xyz[i];
    }
    return ctx.oersted.h_xyz;
}

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
    const fullmag_fem_stage_oersted_callback_v1 &callback,
    std::string &error)
{
    if (callback.abi_version != FULLMAG_FEM_STAGE_OERSTED_CALLBACK_ABI_VERSION) {
        error = "stage Oersted callback ABI version is unsupported";
        return false;
    }
    if (callback.struct_size < sizeof(fullmag_fem_stage_oersted_callback_v1)) {
        error = "stage Oersted callback struct_size is smaller than v1";
        return false;
    }
    if (callback.evaluate == nullptr) {
        error = "stage Oersted callback requires an evaluate function";
        return false;
    }
    return true;
}

bool invoke_attempt_callback(
    const fullmag_fem_stage_oersted_callback_v1 &callback,
    fullmag_fem_stage_oersted_attempt_fn function,
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
    char callback_error[FULLMAG_FEM_STAGE_OERSTED_CALLBACK_ERROR_CAPACITY]{};
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
    message << "stage Oersted callback " << operation << " failed";
    if (callback_error[0] != '\0') {
        message << ": " << callback_error;
    }
    error = message.str();
    return false;
}

} // namespace

bool materialize_oersted_stage_field(
    Context &ctx,
    const std::vector<double> &m_xyz,
    double evaluation_time_s,
    uint64_t stage_identity,
    std::string &error)
{
    if (!ctx.oersted.has_stage_callback) {
        materialize_oersted_field(ctx, evaluation_time_s);
        return true;
    }
    if (mfem_device_requests_gpu(ctx)) {
        error = "stage Oersted callback is CPU-only until its device-resident lane is qualified";
        return false;
    }
    const auto &callback = ctx.oersted.stage_callback;
    const uint64_t field_len = static_cast<uint64_t>(m_xyz.size());
    ctx.oersted.h_xyz.assign(m_xyz.size(), 0.0);
    uint64_t source_state_revision = 0;
    char callback_error[FULLMAG_FEM_STAGE_OERSTED_CALLBACK_ERROR_CAPACITY]{};
    const int status = callback.evaluate(
        callback.user_data,
        m_xyz.data(),
        field_len,
        evaluation_time_s,
        stage_identity,
        ctx.oersted.h_xyz.data(),
        field_len,
        &source_state_revision,
        callback_error,
        sizeof(callback_error));
    if (status != 0) {
        copy_callback_error(
            error,
            callback_error,
            sizeof(callback_error),
            "stage Oersted callback evaluate failed");
        ctx.oersted.h_xyz.clear();
        return false;
    }
    if (!std::all_of(
            ctx.oersted.h_xyz.begin(),
            ctx.oersted.h_xyz.end(),
            [](double value) { return std::isfinite(value); })) {
        error = "stage Oersted callback returned a non-finite field";
        ctx.oersted.h_xyz.clear();
        return false;
    }
    ctx.oersted.stage_identity = stage_identity;
    ctx.oersted.stage_source_state_revision = source_state_revision;
    return true;
}

bool begin_oersted_stage_attempt(
    Context &ctx,
    uint64_t target_step,
    uint64_t attempt_identity,
    double time_start_s,
    double dt_seconds,
    std::string &error)
{
    if (!ctx.oersted.has_stage_callback) {
        return true;
    }
    if (ctx.oersted.stage_attempt_active) {
        error = "stage Oersted callback attempt is already active";
        return false;
    }
    if (!invoke_attempt_callback(
            ctx.oersted.stage_callback,
            ctx.oersted.stage_callback.begin_attempt,
            target_step,
            attempt_identity,
            time_start_s,
            dt_seconds,
            error,
            "begin_attempt")) {
        return false;
    }
    ctx.oersted.stage_attempt_active = true;
    ctx.oersted.stage_attempt_target_step = target_step;
    ctx.oersted.stage_attempt_identity = attempt_identity;
    ctx.oersted.stage_attempt_time_start_s = time_start_s;
    ctx.oersted.stage_attempt_dt_seconds = dt_seconds;
    return true;
}

bool commit_oersted_stage_attempt(Context &ctx, std::string &error)
{
    if (!ctx.oersted.has_stage_callback || !ctx.oersted.stage_attempt_active) {
        return true;
    }
    const bool ok = invoke_attempt_callback(
        ctx.oersted.stage_callback,
        ctx.oersted.stage_callback.commit_attempt,
        ctx.oersted.stage_attempt_target_step,
        ctx.oersted.stage_attempt_identity,
        ctx.oersted.stage_attempt_time_start_s,
        ctx.oersted.stage_attempt_dt_seconds,
        error,
        "commit_attempt");
    if (ok) {
        ctx.oersted.stage_attempt_active = false;
        ctx.oersted.stage_attempt_target_step = 0;
        ctx.oersted.stage_attempt_identity = 0;
        ctx.oersted.stage_attempt_time_start_s = 0.0;
        ctx.oersted.stage_attempt_dt_seconds = 0.0;
    }
    return ok;
}

bool rollback_oersted_stage_attempt(Context &ctx, std::string &error)
{
    if (!ctx.oersted.has_stage_callback || !ctx.oersted.stage_attempt_active) {
        return true;
    }
    const bool ok = invoke_attempt_callback(
        ctx.oersted.stage_callback,
        ctx.oersted.stage_callback.rollback_attempt,
        ctx.oersted.stage_attempt_target_step,
        ctx.oersted.stage_attempt_identity,
        ctx.oersted.stage_attempt_time_start_s,
        ctx.oersted.stage_attempt_dt_seconds,
        error,
        "rollback_attempt");
    ctx.oersted.stage_attempt_active = false;
    ctx.oersted.stage_attempt_target_step = 0;
    ctx.oersted.stage_attempt_identity = 0;
    ctx.oersted.stage_attempt_time_start_s = 0.0;
    ctx.oersted.stage_attempt_dt_seconds = 0.0;
    return ok;
}

bool configure_oersted_stage_callback(
    Context &ctx,
    const fullmag_fem_stage_oersted_callback_v1 *callback,
    std::string &error)
{
    if (callback == nullptr) {
        ctx.oersted.has_stage_callback = false;
        ctx.oersted.stage_callback = {};
        ctx.oersted.stage_attempt_active = false;
        ctx.oersted.stage_attempt_target_step = 0;
        ctx.oersted.stage_attempt_identity = 0;
        ctx.oersted.stage_attempt_time_start_s = 0.0;
        ctx.oersted.stage_attempt_dt_seconds = 0.0;
        ctx.oersted.stage_identity = 0;
        ctx.oersted.stage_source_state_revision = 0;
        ctx.stepper.workspace.fsal_valid = false;
        return true;
    }
    if (!callback_layout_is_valid(*callback, error)) {
        return false;
    }
    if (ctx.oersted.stage_attempt_active) {
        error = "cannot replace a stage Oersted callback during an active attempt";
        return false;
    }
    ctx.oersted.stage_callback = *callback;
    ctx.oersted.has_stage_callback = true;
    ctx.oersted.stage_identity = 0;
    ctx.oersted.stage_source_state_revision = 0;
    ctx.stepper.workspace.fsal_valid = false;
    return true;
}

void add_oersted_field(
    const Context &ctx,
    double evaluation_time_s,
    std::vector<double> &h_eff_xyz)
{
    const auto &h_oe_xyz = ctx.oersted.has_stage_callback
        ? ctx.oersted.h_xyz
        : materialize_oersted_field(const_cast<Context &>(ctx), evaluation_time_s);
    const size_t count = std::min(h_eff_xyz.size(), h_oe_xyz.size());
    for (size_t i = 0; i < count; ++i) {
        h_eff_xyz[i] += h_oe_xyz[i];
    }
}

} // namespace fullmag::fem

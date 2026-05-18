#pragma once

#include "fullmag_fem.h"

#include <string>

namespace fullmag::fem {

struct Context;

/*
 * Initialize native FEM field-refresh plan fields.
 *
 * Validates the ABI field-refresh policy, copies it into Context, and resets
 * the demag frozen-field cache state used when a refresh interval is active.
 *
 * It does not solve demag, compose H_eff, own state I/O, or publish step
 * metrics.
 */
bool initialize_field_refresh_plan_fields(
    Context &ctx,
    const fullmag_fem_field_refresh_policy &policy,
    std::string &error);

} // namespace fullmag::fem
